/**
 * 运行时：预注册命令的执行、裸进程启停、健康探活。
 *
 * 纪律：
 * 1. 永远 `shell:false` + 参数数组，命令与参数只来自服务器本地配置，请求侧给不了。
 * 2. `stop` 失败不直接判发布失败——进程本来就没跑是常见情况；但 `start` 失败一定失败。
 * 3. 健康检查区分三类结果：通过 / 明确失败（命令非 0、连接被拒）/ 超时未通过。
 *    只有「通过」算成功；超时也必须回 failing，不能让发布假成功。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DeployCommand, HealthCheck } from './contracts.ts';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 8_000;

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n（输出已截断）` : text;
}

/** cwd 只有两种合法值：版本目录或应用根。 */
export function resolveCwd(root: string, cwd: DeployCommand['cwd']): string {
  return cwd === 'root' ? root : join(root, 'current');
}

export interface RunOptions {
  readonly root: string;
  readonly command: DeployCommand;
  /** 覆盖 cwd（install 命令要在刚解压的版本目录里跑，而不是 current）。 */
  readonly cwdOverride?: string;
}

export function runCommand(options: RunOptions): Promise<RunResult> {
  const { command } = options;
  const cwd = options.cwdOverride ?? resolveCwd(options.root, command.cwd);
  const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Windows + Node 的坑：可执行文件路径用正斜杠时，cmd.exe 这类宿主会报「命令语法不正确」。
  // 只规范化 command 本身（路径），不动 args —— 参数里可能有 URL 之类必须保留正斜杠的值。
  const executable = process.platform === 'win32'
    ? command.command.replace(/\//g, '\\')
    : command.command;
  return new Promise<RunResult>((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(executable, command.args ?? [], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      done({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8'); });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      done({ code: -1, stdout: cap(stdout), stderr: cap(`${stderr}${error.message}`), timedOut });
    });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      done({ code: typeof code === 'number' ? code : -1, stdout: cap(stdout), stderr: cap(stderr), timedOut });
    });
  });
}

export interface StepOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

export async function startApp(root: string, start: DeployCommand): Promise<StepOutcome> {
  const result = await runCommand({ root, command: start });
  if (result.code === 0) return { ok: true, detail: 'start 命令退出 0' };
  return { ok: false, detail: `start 失败（退出码 ${result.code}${result.timedOut ? '，超时' : ''}）：${firstLine(result.stderr || result.stdout)}` };
}

/** 停止是「尽力而为」：配置了才调，退出码非 0 只记原因，不阻断后续切换。 */
export async function stopApp(root: string, stop: DeployCommand | undefined): Promise<StepOutcome> {
  if (stop === undefined) return { ok: true, detail: '未配置 stop，跳过' };
  const result = await runCommand({ root, command: stop });
  if (result.code === 0) return { ok: true, detail: 'stop 命令退出 0' };
  return { ok: true, detail: `stop 退出码 ${result.code}（进程可能本就没在跑）` };
}

export async function statusApp(root: string, status: DeployCommand | undefined): Promise<StepOutcome> {
  if (status === undefined) return { ok: false, detail: '未配置 status 命令' };
  const result = await runCommand({ root, command: status });
  return { ok: result.code === 0, detail: firstLine(result.stdout || result.stderr || `退出码 ${result.code}`) };
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export interface HealthOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly attempts: number;
}

async function probeUrl(url: string, expectStatus: number, timeoutMs: number): Promise<StepOutcome> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)), redirect: 'manual' });
    if (response.status === expectStatus) return { ok: true, detail: `HTTP ${response.status}` };
    return { ok: false, detail: `HTTP ${response.status}，期望 ${expectStatus}` };
  } catch (error) {
    return { ok: false, detail: `请求失败：${error instanceof Error ? firstLine(error.message) : String(error)}` };
  }
}

/**
 * 轮询直到通过或超时。两种探针都给时优先 url（更接近用户真实访问路径），
 * 命令探针留作「没有监听端口」的服务（例如纯 worker）。
 */
export async function waitHealthy(root: string, health: HealthCheck | undefined): Promise<HealthOutcome> {
  if (health === undefined) return { ok: true, detail: '未配置健康检查，跳过', attempts: 0 };
  const timeoutMs = health.timeoutMs ?? 60_000;
  const intervalMs = health.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last: StepOutcome = { ok: false, detail: '尚未探测' };
  for (;;) {
    attempts += 1;
    if (health.url !== undefined) {
      last = await probeUrl(health.url, health.expectStatus ?? 200, timeoutMs);
    } else if (health.command !== undefined) {
      const result = await runCommand({ root, command: health.command });
      last = result.code === 0
        ? { ok: true, detail: '健康检查命令退出 0' }
        : { ok: false, detail: `健康检查命令退出码 ${result.code}：${firstLine(result.stderr || result.stdout)}` };
    } else {
      return { ok: true, detail: '健康检查未配置探针，跳过', attempts: 1 };
    }
    if (last.ok) return { ok: true, detail: last.detail, attempts };
    if (Date.now() >= deadline) return { ok: false, detail: `${last.detail}（${attempts} 次探测后超时）`, attempts };
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
