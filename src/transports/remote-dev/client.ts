/**
 * 开发通道客户端：把「一行请求 / 一行响应」包装成可 await 的方法。
 *
 * 三条纪律：
 * 1. 超时必须给出明确错误（ErrorCode.TRANSPORT_TIMEOUT），不能让调用方永远挂着：
 *    SSH 通道断在半路时 TCP 可能很久才报错，没有本地超时就是无限等待。
 * 2. 协议版本不符立刻回 PROTOCOL_MISMATCH，不尝试按旧字段解析——字段语义变了以后
 *    猜着读会把写错的内容提交到服务器。
 * 3. 未知 id / 非法行一律忽略并继续工作（乱序、重复、对端多余输出都可能出现），
 *    一次畸形回复不能让后续所有请求都失败。
 */
import { ErrorCode, AirlockError } from '../../contracts/errors.ts';
import { devStatusSchema, devOps, REMOTE_DEV_PROTOCOL } from '../../contracts/remote.ts';
import type { DevApplyResult, DevFileEntry, DevJob, DevRead, DevRequest, DevStatus, DevResponse } from '../../contracts/remote.ts';
import { encodeRequest, parseResponse, RemoteDevError } from './protocol.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const TERMINAL_JOB = new Set<DevJob['status']>(['succeeded', 'failed', 'cancelled']);

export type DevOp = (typeof devOps)[number];

/** 传输抽象：SSH 子进程、内存管道、测试假件都实现这三个方法。 */
export interface DevTransport {
  send(line: string): void;
  onLine(handler: (line: string) => void): () => void;
  close(): void;
}

export interface RemoteDevClientOptions {
  readonly transport: DevTransport;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly leaseId?: string;
}

export interface RemoteDevClient {
  request(op: DevOp, params?: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  status(): Promise<DevStatus>;
  list(path?: string): Promise<{ entries: readonly DevFileEntry[]; truncated: boolean }>;
  read(path: string, maxBytes?: number): Promise<DevRead>;
  acquireLease(owner: string): Promise<{ id: string; owner: string; expiresAt: number }>;
  releaseLease(leaseId?: string): Promise<{ released: boolean }>;
  apply(params: Record<string, unknown>): Promise<DevApplyResult>;
  gitStatus(): Promise<{ status: string; clean: boolean; truncated: boolean }>;
  gitDiff(options?: { path?: string; stat?: boolean }): Promise<{ diff: string; truncated: boolean }>;
  check(task: string): Promise<DevJob>;
  jobStatus(jobId: string): Promise<DevJob>;
  jobCancel(jobId: string): Promise<DevJob>;
  releaseRequest(params: Record<string, unknown>): Promise<unknown>;
  waitJob(jobId: string, options?: { timeoutMs?: number; intervalMs?: number }): Promise<DevJob>;
  close(): void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createRemoteDevClient(options: RemoteDevClientOptions): RemoteDevClient {
  const defaultTimeout = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let leaseId: string | undefined;
  let closed = false;

  function settleReject(id: number, error: Error): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  const off = options.transport.onLine((line: string) => {
    const parsed = parseResponse(line);
    if (parsed.kind === 'invalid') return; // 乱序 / 非 JSON / 结构不符：忽略，等待自己的那条
    if (parsed.kind === 'protocol-mismatch') {
      settleReject(parsed.id, new RemoteDevError('PROTOCOL_MISMATCH', `对端协议版本与本地 ${REMOTE_DEV_PROTOCOL} 不一致`));
      return;
    }
    const response: DevResponse = parsed.response;
    const entry = pending.get(response.id);
    if (entry === undefined) return; // 未知 id：可能已被超时清理，忽略
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) {
      entry.resolve(response.data);
      return;
    }
    const error = response.error;
    entry.reject(new RemoteDevError(error?.code ?? 'INTERNAL', error?.message ?? '开发通道返回失败', error?.detail));
  });

  function request(op: DevOp, params: Record<string, unknown> = {}, requestOptions: RequestOptions = {}): Promise<unknown> {
    if (!(devOps as readonly string[]).includes(op)) {
      return Promise.reject(new RemoteDevError('INVALID_REQUEST', `未知 op：${String(op)}`));
    }
    if (closed) return Promise.reject(new AirlockError(ErrorCode.TRANSPORT_DISCONNECTED, '开发通道已关闭'));
    const id = nextId;
    nextId += 1;
    const timeoutMs = Math.max(100, requestOptions.timeoutMs ?? defaultTimeout);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AirlockError(ErrorCode.TRANSPORT_TIMEOUT, `开发通道请求超时：${op}（${timeoutMs}ms）`, { detail: { op, id } }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const request: DevRequest = { v: REMOTE_DEV_PROTOCOL, id, op, params, ...(requestOptions.leaseId === undefined ? {} : { leaseId: requestOptions.leaseId }) };
      try {
        options.transport.send(encodeRequest(request));
      } catch (error) {
        settleReject(id, new AirlockError(ErrorCode.TRANSPORT_DISCONNECTED, `开发通道发送失败：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  async function status(): Promise<DevStatus> {
    const data = await request('status');
    const parsed = devStatusSchema.safeParse(data);
    if (!parsed.success) throw new RemoteDevError('INTERNAL', 'status 响应不符合契约');
    return parsed.data;
  }

  async function acquireLease(owner: string): Promise<{ id: string; owner: string; expiresAt: number }> {
    const data = (await request('lease-acquire', { owner })) as { lease?: { id?: unknown; owner?: unknown; expiresAt?: unknown } };
    const lease = data.lease;
    if (lease === undefined || typeof lease.id !== 'string' || typeof lease.owner !== 'string' || typeof lease.expiresAt !== 'number') {
      throw new RemoteDevError('INTERNAL', 'lease-acquire 响应缺少租约');
    }
    leaseId = lease.id;
    return { id: lease.id, owner: lease.owner, expiresAt: lease.expiresAt };
  }

  async function releaseLease(provided?: string): Promise<{ released: boolean }> {
    const data = (await request('lease-release', {}, provided === undefined && leaseId === undefined ? {} : { leaseId: provided ?? leaseId })) as { released?: unknown };
    if (provided === undefined || provided === leaseId) leaseId = undefined;
    return { released: data.released === true };
  }

  async function waitJob(jobId: string, waitOptions: { timeoutMs?: number; intervalMs?: number } = {}): Promise<DevJob> {
    const timeoutMs = Math.max(100, waitOptions.timeoutMs ?? 60_000);
    const intervalMs = Math.max(20, waitOptions.intervalMs ?? 200);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await request('job-status', { jobId });
      const parsed = job as DevJob;
      if (TERMINAL_JOB.has(parsed.status)) return parsed;
      if (Date.now() >= deadline) {
        throw new AirlockError(ErrorCode.TRANSPORT_TIMEOUT, `等待任务超时：${jobId}`, { detail: { jobId, status: parsed.status } });
      }
      await new Promise<void>(resolveTimeout => { setTimeout(resolveTimeout, intervalMs); });
    }
  }

  return {
    request,
    status,
    async list(path?: string) {
      return (await request('list', path === undefined ? {} : { path })) as { entries: readonly DevFileEntry[]; truncated: boolean };
    },
    async read(path: string, maxBytes?: number) {
      return (await request('read', maxBytes === undefined ? { path } : { path, maxBytes })) as DevRead;
    },
    acquireLease,
    releaseLease,
    async apply(params: Record<string, unknown>) {
      const id = leaseId;
      if (id === undefined) throw new RemoteDevError('LEASE_REQUIRED', '尚未获取租约，请先 acquireLease');
      return (await request('apply', params, { leaseId: id })) as DevApplyResult;
    },
    async gitStatus() {
      return (await request('git-status')) as { status: string; clean: boolean; truncated: boolean };
    },
    async gitDiff(diffOptions?: { path?: string; stat?: boolean }) {
      return (await request('git-diff', { ...(diffOptions ?? {}) })) as { diff: string; truncated: boolean };
    },
    async check(task: string) {
      return (await request('check', { task })) as DevJob;
    },
    async jobStatus(jobId: string) {
      return (await request('job-status', { jobId })) as DevJob;
    },
    async jobCancel(jobId: string) {
      return (await request('job-cancel', { jobId })) as DevJob;
    },
    async releaseRequest(params: Record<string, unknown>) {
      return request('release-request', params);
    },
    waitJob,
    close(): void {
      if (closed) return;
      closed = true;
      off();
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new AirlockError(ErrorCode.TRANSPORT_DISCONNECTED, '开发通道已关闭'));
        pending.delete(id);
      }
      options.transport.close();
    },
  };
}
