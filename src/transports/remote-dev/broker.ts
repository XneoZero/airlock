/**
 * 开发通道 Broker：12 个 op 的唯一入口。
 * 分权：读 op 不需要租约；apply 必须持有效租约且 writable；check 只跑预注册任务；
 * release-request 冻结内容摘要 + 检查记录并写 releaseInbox，同 releaseId 幂等。
 * 失败一律转成 DEV_ERROR_CODES 响应，进程不退出——Broker 是长连接里的常驻对端。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { deriveReleaseId, REMOTE_DEV_PROTOCOL, releaseCheckSchema, releaseRequestSchema, type DevRequest, type DevResponse, type DevStatus, type ReleaseCheck, type ReleaseRequest } from '../../contracts/remote.ts';
import { createJobStore, createLeaseStore, type JobStore, type JobTaskConfig, type LeaseStore } from './jobs.ts';
import { encodeResponse, errorResponse, parseLine, RemoteDevError } from './protocol.ts';
import { apply as applyFile, contentDigest, createOperationLedger, list as listWorkspace, read as readWorkspace, writeFileAtomic, type ApplyEdit, type OperationLedger } from './workspace.ts';

const BROKER_VERSION = `dev-broker/${REMOTE_DEV_PROTOCOL}`;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const GIT_CAP = 64 * 1024;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
export interface BrokerConfig {
  readonly profileId: string; readonly serverId: string; readonly workspaceId: string; readonly root: string; readonly writable: boolean;
  readonly stateDir: string; readonly releaseInbox: string; readonly tasks: Readonly<Record<string, JobTaskConfig>>;
  readonly maxFileBytes?: number; readonly maxListEntries?: number; readonly clock?: () => number;
  readonly leaseTtlMs?: number; readonly releaseChannel?: 'stable' | 'dev';
}
export interface Broker {
  readonly serverId: string;
  readonly workspaceId: string;
  dispatch(request: DevRequest): Promise<DevResponse>;
  /** 一行输入 → 一行输出（空行返回 null）。stdio 装配与测试都走这里。 */
  handleLine(line: string): Promise<string | null>;
  close(): void;
}
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
export function createBroker(config: BrokerConfig): Broker {
  const clock = config.clock ?? Date.now;
  const leaseTtlMs = Math.max(1000, config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
  const bootId = `boot-${randomBytes(8).toString('hex')}`;
  const ledger: OperationLedger = createOperationLedger(config.stateDir);
  const leases: LeaseStore = createLeaseStore(config.stateDir);
  const jobs: JobStore = createJobStore({ root: config.root, stateDir: config.stateDir, tasks: config.tasks, clock });
  /** 过期即视为不存在：过期记录留给下一次 acquire 覆盖，不主动删（便于排查上一任持有者）。 */
  async function activeLease(): Promise<Awaited<ReturnType<LeaseStore['read']>>> {
    const lease = await leases.read();
    return lease !== null && lease.expiresAt > clock() ? lease : null;
  }
  async function requireLease(request: DevRequest): Promise<void> {
    if (!config.writable) throw new RemoteDevError('WRITE_DISABLED', '本工作区为只读（writable=false）');
    const provided = text(request.leaseId) ?? text(request.params.leaseId);
    if (provided === undefined) throw new RemoteDevError('LEASE_REQUIRED', '写操作需要 leaseId');
    const lease = await activeLease();
    if (lease === null) throw new RemoteDevError('LEASE_REQUIRED', '没有有效租约，请先 lease-acquire');
    if (lease.id !== provided) throw new RemoteDevError('LEASE_REQUIRED', 'leaseId 与当前租约不符');
  }
  /** 固定参数 + `shell:false`：git 只是信息源，不接受请求侧拼出的任何选项。 */
  function runGit(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((done, fail) => {
      const child = spawn('git', ['-C', config.root, ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const append = (cur: string, chunk: Buffer): string => cur.length >= GIT_CAP ? cur : cur + chunk.toString('utf8').slice(0, GIT_CAP - cur.length);
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once('error', (error: Error) => { clearTimeout(timer); fail(error); });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        done({ code: typeof code === 'number' ? code : -1, stdout, stderr });
      });
    });
  }
  async function gitText(args: readonly string[], what: string): Promise<{ stdout: string; truncated: boolean }> {
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await runGit(args);
    } catch {
      throw new RemoteDevError('INTERNAL', `${what} 无法执行（git 未安装或不在 PATH？）`);
    }
    if (result.code !== 0) {
      const reason = /not a git/i.test(result.stderr) ? '工作区不是 git 仓库' : result.stderr.trim().split(/\r?\n/)[0] ?? '未知原因';
      throw new RemoteDevError('INTERNAL', `${what} 失败：${reason.slice(0, 200)}`);
    }
    const truncated = result.stdout.length >= GIT_CAP;
    return { stdout: truncated ? `${result.stdout}\n（输出已截断）` : result.stdout, truncated };
  }

  async function acquireLease(params: Record<string, unknown>): Promise<unknown> {
    const owner = text(params.owner);
    if (owner === undefined || owner.length > 64) throw new RemoteDevError('INVALID_REQUEST', 'lease-acquire 需要 owner（1..64 字符）');
    const current = await activeLease();
    if (current !== null && current.owner !== owner) {
      throw new RemoteDevError('LEASE_CONFLICT', `租约被 ${current.owner} 持有，到期时间 ${new Date(current.expiresAt).toISOString()}`, { expiresAt: current.expiresAt });
    }
    // 同 owner 续租沿用原 id：租约身份跟着写者走，客户端不必重新记录 leaseId。
    const lease = current === null
      ? { id: `lease-${randomBytes(8).toString('hex')}`, owner, expiresAt: clock() + leaseTtlMs }
      : { ...current, expiresAt: clock() + leaseTtlMs };
    await leases.write(lease);
    return { lease: { id: lease.id, owner: lease.owner, expiresAt: lease.expiresAt } };
  }

  async function releaseLease(request: DevRequest): Promise<unknown> {
    const current = await activeLease();
    if (current === null) return { released: false };
    const provided = text(request.leaseId) ?? text(request.params.leaseId);
    if (provided !== undefined && provided !== current.id) throw new RemoteDevError('LEASE_CONFLICT', 'leaseId 不是当前租约');
    await leases.write(null);
    return { released: true };
  }

  async function applyOp(request: DevRequest): Promise<unknown> {
    await requireLease(request);
    const params = request.params;
    const path = text(params.path);
    if (path === undefined) throw new RemoteDevError('INVALID_REQUEST', 'apply 需要 path');
    const operationId = text(params.operationId);
    if (operationId === undefined || !OPERATION_ID.test(operationId)) throw new RemoteDevError('INVALID_REQUEST', 'operationId 不合法');
    const rawExpected = params.expectedHash;
    if (rawExpected !== null && (typeof rawExpected !== 'string' || !/^[a-f0-9]{64}$/.test(rawExpected))) throw new RemoteDevError('INVALID_REQUEST', 'expectedHash 必须是 64 位十六进制或 null');
    const expectedHash = rawExpected as string | null;
    const content = typeof params.content === 'string' ? params.content : undefined;
    const edits = Array.isArray(params.edits) ? (params.edits as ApplyEdit[]) : undefined;
    if ((content === undefined) === (edits === undefined)) throw new RemoteDevError('INVALID_REQUEST', 'content 与 edits 必须二选一');
    return applyFile(config.root, path, { content, edits, expectedHash, operationId }, { maxFileBytes: config.maxFileBytes, ledger });
  }

  async function listOp(params: Record<string, unknown>): Promise<unknown> {
    const result = await listWorkspace(config.root, { maxEntries: Math.max(1, config.maxListEntries ?? 500) });
    const prefix = text(params.path);
    if (prefix === undefined) return result;
    const base = prefix.replace(/\/+$/, '');
    return { entries: result.entries.filter(entry => entry.path === prefix || entry.path.startsWith(`${base}/`)), truncated: result.truncated };
  }

  async function gitDiffOp(params: Record<string, unknown>): Promise<unknown> {
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (params.stat === true) args.push('--stat');
    const path = text(params.path);
    if (path !== undefined) {
      if (path.includes('\u0000') || path.split(/[\\/]+/).includes('..') || /^[A-Za-z]:/.test(path)) {
        throw new RemoteDevError('PATH_OUT_OF_SCOPE', 'diff 的 path 必须是工作区相对路径');
      }
      args.push('--', path);
    }
    const result = await gitText(args, 'git diff');
    return { diff: result.stdout, truncated: result.truncated };
  }

  /**
   * 发布申请。冻结 = 「内容摘要 + 当前检查记录」，releaseId 由两者共同派生（契约 deriveReleaseId）；
   * 审批侧用同一函数复核，所以任何一方改变都会换 id，不会出现「批准 A 却发布 B」。
   */
  async function releaseRequestOp(params: Record<string, unknown>): Promise<unknown> {
    const requestedBy = text(params.requestedBy);
    if (requestedBy === undefined || requestedBy.length > 64) throw new RemoteDevError('INVALID_REQUEST', 'release-request 需要 requestedBy（1..64 字符）');
    const checks: ReleaseCheck[] = [];
    for (const item of (Array.isArray(params.checks) ? params.checks : []).slice(0, 32)) {
      const parsed = releaseCheckSchema.safeParse(item);
      if (!parsed.success) throw new RemoteDevError('INVALID_REQUEST', 'checks 里有一条不符合契约');
      checks.push(parsed.data);
    }
    // 没有一条通过的工作区检查记录就不允许冻结：发布必须绑定「当时检查过」的证据。
    if (!checks.some(check => check.ok)) throw new RemoteDevError('INVALID_REQUEST', '缺少通过的工作区检查记录');
    let porcelain = '';
    try {
      const status = await runGit(['status', '--porcelain=v1', '--untracked-files=normal']);
      if (status.code === 0) porcelain = status.stdout;
    } catch { porcelain = ''; } // 非 git 工作区：没有提交历史可对比，摘要仍覆盖全部文件
    if (porcelain.trim() !== '') throw new RemoteDevError('INVALID_REQUEST', '工作区有未提交改动，拒绝冻结');
    let added = 0, changed = 0, removed = 0;
    for (const line of porcelain.split(/\r?\n/)) {
      if (line.length < 3) continue;
      const code = line.slice(0, 2);
      if (code === '??' || code.includes('A')) added += 1;
      else if (code.includes('D')) removed += 1;
      else changed += 1;
    }
    let commit: string | null = null;
    try {
      const rev = await runGit(['rev-parse', 'HEAD']);
      if (rev.code === 0) commit = rev.stdout.trim().slice(0, 64) || null;
    } catch { commit = null; }
    const frozen = await contentDigest(config.root, { maxFileBytes: config.maxFileBytes });
    const sortedChecks = [...checks].sort((a, b) => a.task.localeCompare(b.task) || a.at - b.at || String(a.outputDigest).localeCompare(String(b.outputDigest)));
    const frozenHash = sha256(JSON.stringify({ v: 1, contentDigest: frozen.digest, files: frozen.files, diff: { added, changed, removed }, commit, checks: sortedChecks }));
    const releaseId = deriveReleaseId(frozenHash, frozen.digest);
    const inboxFile = join(config.releaseInbox, `${releaseId}.json`);
    try {
      const existing = releaseRequestSchema.safeParse(JSON.parse(await readFile(inboxFile, 'utf8')));
      if (!existing.success) throw new Error('结构不符');
      // 同 releaseId 已存在：回已有申请，不重写（重写会让批准方看到的快照换掉）。
      return { releaseId, frozenHash, contentDigest: frozen.digest, duplicate: true, request: existing.data };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'ENOENT') throw new RemoteDevError('INTERNAL', `已有发布申请不可读：${releaseId}`);
    }
    // profileId 是客户端档案 id（serverId 是 srv-xxxx）；填错审批侧会按 FORBIDDEN 拒。
    const parsed = releaseRequestSchema.safeParse({
      releaseId, profileId: config.profileId, workspaceId: config.workspaceId, frozenHash,
      contentDigest: frozen.digest, commit, files: frozen.files, diff: { added, changed, removed }, checks: sortedChecks,
      migration: typeof params.migration === 'object' && params.migration !== null ? params.migration : { required: false, notes: null },
      rollback: typeof params.rollback === 'object' && params.rollback !== null ? params.rollback : { strategy: 'code-only', notes: null },
      requestedBy, at: clock(),
    });
    if (!parsed.success) throw new RemoteDevError('INVALID_REQUEST', `发布申请不符合契约：${parsed.error.issues[0]?.path.join('.') ?? ''}`);
    const request: ReleaseRequest = parsed.data;
    await mkdir(config.releaseInbox, { recursive: true });
    await writeFileAtomic(inboxFile, JSON.stringify(request));
    return { releaseId, frozenHash, contentDigest: frozen.digest, duplicate: false, request };
  }

  async function route(request: DevRequest): Promise<unknown> {
    const params = request.params;
    switch (request.op) {
      case 'status': {
        const lease = await activeLease();
        const status: DevStatus = {
          protocol: REMOTE_DEV_PROTOCOL, serverId: config.serverId, workspaceId: config.workspaceId, root: config.root,
          version: BROKER_VERSION, bootId, writable: config.writable,
          lease: lease === null ? null : { id: lease.id, owner: lease.owner, expiresAt: lease.expiresAt },
          tasks: [...jobs.tasks], observedAt: clock(),
        };
        return status;
      }
      case 'lease-acquire': return acquireLease(params);
      case 'lease-release': return releaseLease(request);
      case 'list': return listOp(params);
      case 'read': {
        const path = text(params.path);
        if (path === undefined) throw new RemoteDevError('INVALID_REQUEST', 'read 需要 path');
        return readWorkspace(config.root, path, typeof params.maxBytes === 'number' ? params.maxBytes : config.maxFileBytes);
      }
      case 'apply': return applyOp(request);
      case 'git-status': {
        const result = await gitText(['status', '--porcelain=v1', '--untracked-files=normal'], 'git status');
        return { status: result.stdout, clean: result.stdout.trim() === '', truncated: result.truncated };
      }
      case 'git-diff': return gitDiffOp(params);
      case 'check': {
        const task = text(params.task);
        if (task === undefined) throw new RemoteDevError('UNKNOWN_TASK', 'check 需要 task');
        return jobs.start(task);
      }
      case 'job-status': {
        const jobId = text(params.jobId);
        if (jobId === undefined) throw new RemoteDevError('JOB_NOT_FOUND', 'job-status 需要 jobId');
        return jobs.status(jobId);
      }
      case 'job-cancel': {
        const jobId = text(params.jobId);
        if (jobId === undefined) throw new RemoteDevError('JOB_NOT_FOUND', 'job-cancel 需要 jobId');
        return jobs.cancel(jobId);
      }
      case 'release-request': return releaseRequestOp(params);
      default: throw new RemoteDevError('INVALID_REQUEST', `未知 op：${String(request.op)}`);
    }
  }

  const broker: Broker = {
    serverId: config.serverId,
    workspaceId: config.workspaceId,
    async dispatch(request: DevRequest): Promise<DevResponse> {
      try {
        return { v: REMOTE_DEV_PROTOCOL, id: request.id, ok: true, data: await route(request) };
      } catch (error) {
        if (error instanceof RemoteDevError) return errorResponse(request.id, error.code, error.message, error.detail);
        // 未预期异常也只给 INTERNAL：把堆栈发给远端等于泄露服务器路径与实现细节。
        return errorResponse(request.id, 'INTERNAL', 'Broker 内部错误');
      }
    },
    async handleLine(line: string): Promise<string | null> {
      const parsed = parseLine(line);
      if (parsed.kind === 'blank') return null;
      if (parsed.kind === 'invalid') return encodeResponse(parsed.response);
      return encodeResponse(await broker.dispatch(parsed.request));
    },
    close(): void { jobs.close(); },
  };
  return broker;
}

/** stdio 装配：读一行、跑一个 op、写一行。stdout 只走协议；对端是本机 SSH 通道。 */
export function createStdioBroker(config: BrokerConfig, input: Readable, output: Writable): { broker: Broker; close: () => void } {
  const broker = createBroker(config);
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line: string) => {
    void broker.handleLine(line)
      .then(written => { if (written !== null) output.write(written); })
      .catch(() => { output.write(encodeResponse(errorResponse(0, 'INTERNAL', 'Broker 内部错误'))); });
  });
  return { broker, close: () => { lines.close(); broker.close(); } };
}
