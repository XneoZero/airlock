/**
 * 预注册检查任务。开发通道的 `check` 只能跑部署时登记过的命令：
 * 只要能传任意命令，Broker 就退化成一台远程 shell，工作区隔离和写租约都白做。
 *
 * 三条纪律：
 * 1. `shell:false` + 参数数组 + 固定 `cwd`，任务配置只从 JSON 读，请求侧只能给任务名；
 * 2. 输出截断 8000 字符（契约上限），否则一次 `npm test` 的全量日志就能把响应撑到几十 MB；
 * 3. 记录落 stateDir（工作区外）并原子写；读到坏记录回 INTERNAL，不静默当成「没有这个任务」。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { devJobSchema } from '../../contracts/remote.ts';
import type { DevJob } from '../../contracts/remote.ts';
import { RemoteDevError } from './protocol.ts';
import { writeFileAtomic } from './workspace.ts';

/** 与契约里 tasks 的正则一致：小写字母开头，允许连字符，2..32 字符。 */
const TASK_NAME = /^[a-z][a-z0-9-]{1,31}$/;
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface JobTaskConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface JobStoreConfig {
  readonly root: string;
  readonly stateDir: string;
  readonly tasks: Readonly<Record<string, JobTaskConfig>>;
  readonly clock?: () => number;
  readonly maxOutput?: number;
}

export interface JobStore {
  readonly tasks: readonly string[];
  start(task: string): Promise<DevJob>;
  status(jobId: string): Promise<DevJob>;
  cancel(jobId: string): Promise<DevJob>;
  close(): void;
}

interface LiveJob {
  child: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  timedOut: boolean;
}

const TERMINAL = new Set<DevJob['status']>(['succeeded', 'failed', 'cancelled']);

export function createJobStore(config: JobStoreConfig): JobStore {
  const clock = config.clock ?? Date.now;
  const jobsDir = join(config.stateDir, 'jobs');
  const maxOutput = Math.max(1000, config.maxOutput ?? DEFAULT_MAX_OUTPUT);
  const maxContent = maxOutput - 48; // 预留空间给「已截断 / 已超时」这类后缀，保证不超契约上限
  const tasks = new Map<string, JobTaskConfig>();
  for (const [name, task] of Object.entries(config.tasks)) {
    if (!TASK_NAME.test(name)) throw new Error(`job-store: 任务名 ${name} 不合法（小写字母开头，2..32 位小写字母/数字/连字符）`);
    if (task === null || typeof task !== 'object' || typeof task.command !== 'string' || task.command === '') {
      throw new Error(`job-store: 任务 ${name} 缺少 command`);
    }
    tasks.set(name, task);
  }
  const records = new Map<string, DevJob>();
  const live = new Map<string, LiveJob>();
  const jobFile = (jobId: string): string => join(jobsDir, `${jobId}.json`);

  /**
   * 每个 job 的写盘串行化：取消与子进程 close 可能同时落同一条记录，
   * 两个 rename 撞同一目标时 Windows 会偶发 EPERM/EBUSY；排队写可消除这类竞态。
   * 失败仍会重试两次（瞬时占用），最终失败才抛给调用方。
   */
  const writeChains = new Map<string, Promise<void>>();
  const persist = (job: DevJob): Promise<void> => {
    const previous = writeChains.get(job.jobId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(jobsDir, { recursive: true });
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await writeFileAtomic(jobFile(job.jobId), JSON.stringify(job));
          return;
        } catch (error) {
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
      throw lastError;
    });
    writeChains.set(job.jobId, next);
    const settle = () => { if (writeChains.get(job.jobId) === next) writeChains.delete(job.jobId); };
    void next.then(settle, settle);
    return next;
  };
  // 事件回调里不能 await：写盘失败只影响重启后的追溯，不能让一次检查因此被判失败。
  const persistLater = (job: DevJob): void => { void persist(job).catch(() => {}); };

  function run(jobId: string, task: JobTaskConfig): void {
    const state: LiveJob = { child: null, timer: null, cancelled: false, timedOut: false };
    live.set(jobId, state);
    let output = '';
    let truncated = false;
    const append = (text: string): void => {
      if (output.length >= maxContent) { truncated = true; return; }
      const room = maxContent - output.length;
      if (text.length > room) { output += text.slice(0, room); truncated = true; return; }
      output += text;
    };
    const compose = (suffix: string | null): string => {
      let text = output;
      if (suffix !== null) text += `\n${suffix}`;
      if (truncated) text += '\n（输出已截断）';
      return text.slice(0, maxOutput);
    };
    const update = (patch: Partial<DevJob>): DevJob => {
      const next: DevJob = { ...(records.get(jobId) as DevJob), ...patch };
      records.set(jobId, next);
      return next;
    };
    const finish = (code: number | null): void => {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      live.delete(jobId);
      const status: DevJob['status'] = state.cancelled ? 'cancelled' : state.timedOut ? 'failed' : code === 0 ? 'succeeded' : 'failed';
      const suffix = state.cancelled ? '（已取消）' : state.timedOut ? '（超时后已终止）' : null;
      const next = update({ status, finishedAt: clock(), exitCode: code, output: compose(suffix) });
      persistLater(next);
    };

    let child: ChildProcess;
    try {
      child = spawn(task.command, [...(task.args ?? [])], { cwd: config.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const next = update({ status: 'failed', finishedAt: clock(), output: compose(`（无法启动：${error instanceof Error ? error.message : String(error)}）`) });
      live.delete(jobId);
      persistLater(next);
      return;
    }
    state.child = child;
    persistLater(update({ status: 'running', startedAt: clock() }));
    const timeoutMs = Math.min(Math.max(1000, task.timeoutMs ?? DEFAULT_TIMEOUT_MS), 3_600_000);
    state.timer = setTimeout(() => {
      state.timedOut = true;
      if (child.exitCode === null) child.kill();
      // kill 在 Windows 上对孙进程不一定生效，超时后必须自己收尾，不能等 close 永不到来。
      setTimeout(() => { if (live.has(jobId)) finish(null); }, 2000).unref?.();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
    child.once('error', (error: Error) => {
      const next = update({ status: 'failed', finishedAt: clock(), output: compose(`（启动失败：${error.message}）`) });
      if (state.timer !== null) clearTimeout(state.timer);
      live.delete(jobId);
      persistLater(next);
    });
    child.once('close', (code: number | null) => finish(typeof code === 'number' ? code : null));
  }

  async function status(jobId: string): Promise<DevJob> {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new RemoteDevError('JOB_NOT_FOUND', 'jobId 不合法');
    const memory = records.get(jobId);
    if (memory !== undefined) return memory;
    let text: string;
    try {
      text = await readFile(jobFile(jobId), 'utf8');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code === 'ENOENT') throw new RemoteDevError('JOB_NOT_FOUND', `找不到任务：${jobId}`);
      throw new RemoteDevError('INTERNAL', `任务记录不可读：${jobId}`);
    }
    try {
      const parsed = devJobSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error('结构不符');
      records.set(jobId, parsed.data);
      return parsed.data;
    } catch {
      throw new RemoteDevError('INTERNAL', `任务记录损坏：${jobId}`);
    }
  }

  return {
    tasks: [...tasks.keys()].sort(),

    async start(task: string): Promise<DevJob> {
      if (typeof task !== 'string' || !TASK_NAME.test(task)) {
        throw new RemoteDevError('UNKNOWN_TASK', `任务名不合法：${String(task)}`);
      }
      const taskConfig = tasks.get(task);
      if (taskConfig === undefined) throw new RemoteDevError('UNKNOWN_TASK', `未预注册的检查任务：${task}`);
      const jobId = `job-${randomBytes(8).toString('hex')}`;
      const queued: DevJob = { jobId, task, status: 'queued', startedAt: null, finishedAt: null, exitCode: null, output: '' };
      records.set(jobId, queued);
      await mkdir(jobsDir, { recursive: true });
      await persist(queued);
      run(jobId, taskConfig);
      return records.get(jobId) ?? queued;
    },

    status,

    async cancel(jobId: string): Promise<DevJob> {
      const job = await status(jobId);
      if (TERMINAL.has(job.status)) return job;
      const state = live.get(jobId);
      if (state !== undefined) {
        state.cancelled = true;
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        if (state.child !== null && state.child.exitCode === null) state.child.kill();
      }
      live.delete(jobId);
      const next: DevJob = { ...job, status: 'cancelled', finishedAt: clock(), exitCode: job.exitCode };
      records.set(jobId, next);
      await persist(next);
      return next;
    },

    close(): void {
      for (const [jobId, state] of live) {
        state.cancelled = true;
        if (state.timer !== null) clearTimeout(state.timer);
        if (state.child !== null && state.child.exitCode === null) state.child.kill();
        live.delete(jobId);
      }
    },
  };
}

/** 写租约的持久记录。与 job 记录同住 stateDir（工作区外）：工作区里的文件不承载控制状态。 */
export interface LeaseRecord {
  readonly id: string;
  readonly owner: string;
  readonly expiresAt: number;
}

export interface LeaseStore {
  /** 读数不做过期判断：过期语义由 Broker 用时钟决定，存储只管持久化。 */
  read(): Promise<LeaseRecord | null>;
  write(lease: LeaseRecord | null): Promise<void>;
}

const LEASE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function isLeaseRecord(value: unknown): value is LeaseRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as LeaseRecord;
  return typeof record.id === 'string' && LEASE_ID.test(record.id) &&
    typeof record.owner === 'string' && record.owner !== '' &&
    typeof record.expiresAt === 'number' && Number.isInteger(record.expiresAt);
}

export function createLeaseStore(stateDir: string): LeaseStore {
  const file = join(stateDir, 'lease.json');
  let cache: LeaseRecord | null | undefined;
  return {
    async read() {
      if (cache === undefined) {
        try {
          const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
          if (!isLeaseRecord(parsed)) throw new Error('结构不符');
          cache = parsed;
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
          // 坏租约不能当「没人写」：那会让两个客户端同时认为自己是唯一写者。
          if (code === 'ENOENT') cache = null;
          else throw new RemoteDevError('INTERNAL', '租约状态文件损坏，拒绝猜测当前写者', { file });
        }
      }
      return cache;
    },
    async write(lease) {
      cache = lease;
      if (lease === null) { await rm(file, { force: true }); return; }
      await mkdir(stateDir, { recursive: true });
      await writeFileAtomic(file, JSON.stringify(lease));
    },
  };
}
