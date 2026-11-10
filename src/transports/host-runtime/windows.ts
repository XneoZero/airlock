/**
 * Windows 服务宿主运行时：`Get-Service` 只读观测，`Restart-Service` / `Start-Service` 动作。
 *
 * PowerShell 是唯一被调用的外壳，服务名只从部署配置来并再过一遍白名单。
 * 脚本里单引号转义成两个单引号：这是 PowerShell 唯一的字符串转义规则，漏了就等于把配置写进代码。
 * 同时 `-ErrorAction Stop` 把「服务不存在」这类非终止错误升级成退出码 1，避免「看起来执行了」。
 */
import { spawn } from 'node:child_process';
import { HOST_ACTIONS, HOST_SERVICES } from '../../contracts/remote.ts';
import type { HostServiceId } from '../../contracts/remote.ts';
import type {
  HostActionResult,
  HostDiagnostics,
  HostEntryObservation,
  HostRuntimeConfig,
  HostRuntimePort,
  HostServiceObservation,
} from './types.ts';

/** 与 systemd 同一套白名单：Windows 服务名允许空格，但空格会给命令行解析留口子，直接不接受。 */
const SERVICE_NAME = /^[A-Za-z0-9._@-]{1,80}$/;
const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

type Runner = NonNullable<HostRuntimeConfig['runner']>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** 默认执行器：`shell:false`、windowsHide、超时 kill、输出有界（与 systemd 侧同一条纪律）。 */
function createDefaultRunner(): Runner {
  return (file, args, timeoutMs) => new Promise((done, fail) => {
    const child = spawn(file, [...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const append = (current: string, chunk: Buffer): string =>
      current.length >= OUTPUT_CAP ? current : current + chunk.toString('utf8').slice(0, OUTPUT_CAP - current.length);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { if (!finished) child.kill(); }, Math.max(200, timeoutMs));
    const settle = (code: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ stdout, stderr, code });
    };
    child.once('error', (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fail(error);
    });
    child.once('close', (code: number | null) => settle(typeof code === 'number' ? code : -1));
  });
}

/** 查询脚本只吐一行 JSON 或 `null`；不要把整段 Get-Service 表格塞进 stdout（本地化后没法解析）。 */
function queryScript(name: string): string {
  return `$s = Get-Service -Name ${quote(name)} -ErrorAction SilentlyContinue; if ($null -eq $s) { 'null' } else { [pscustomobject]@{ status = $s.Status.ToString() } | ConvertTo-Json -Compress }`;
}

/**
 * 派生独立隐藏进程执行重启：Core 重启自己时，同步等待的 PowerShell 与 Core 同属一个服务
 * 生命周期，会被一起杀掉；只有交给脱离的进程才可能跑完。派生成功只代表「请求已交出去」，
 * 所以动作只能报 request-only，真实结果由下次观测确认。
 */
function deriveScript(name: string): string {
  const inner = `Restart-Service -Name ${quote(name)} -ErrorAction Stop`;
  return `Start-Process -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-NonInteractive','-Command','${inner.replace(/'/g, "''")}'`;
}

function parseStatus(stdout: string): string | null {
  const text = stdout.trim();
  if (text === '' || text === 'null') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
      const status = (parsed as { status?: unknown }).status;
      return typeof status === 'string' ? status : null;
    }
    return null;
  } catch {
    return null;
  }
}

function mapStatus(status: string | null): boolean | null {
  if (status === 'Running' || status === 'StartPending' || status === 'ContinuePending') return true;
  if (status === 'Stopped' || status === 'StopPending' || status === 'Paused') return false;
  return null;
}

export function createWindowsRuntime(config: HostRuntimeConfig): HostRuntimePort {
  const runner = config.runner ?? createDefaultRunner();
  const timeoutMs = Math.max(200, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const services = new Map<HostServiceId, string>();
  for (const id of HOST_SERVICES) {
    const name = config.services?.[id];
    if (name === undefined) continue;
    if (typeof name !== 'string' || !SERVICE_NAME.test(name)) {
      throw new Error(`host-runtime: 服务 ${id} 的 Windows 服务名不合法（只允许 A-Za-z0-9._@-，1..80 字符）`);
    }
    services.set(id, name);
  }

  async function probe(id: HostServiceId, name: string, at: number): Promise<HostServiceObservation> {
    try {
      const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', queryScript(name)], timeoutMs);
      const status = parseStatus(result.stdout);
      const running = mapStatus(status);
      const detail = status === null
        ? `Get-Service ${name} 查不到该服务${result.code === 0 ? '' : `（退出码 ${result.code}：${firstLine(result.stderr)}）`}`
        : `Get-Service ${name}: ${status}`;
      return { id, known: true, running, detail, observedAt: at };
    } catch (error) {
      return { id, known: true, running: null, detail: `无法读取 ${name} 状态：${describe(error)}`, observedAt: at };
    }
  }

  /** 入口诊断与 systemd 侧同口径：读不到就 unknown，绝不把失败解释成 down/off。 */
  async function diagnoseEntry(): Promise<HostEntryObservation> {
    let tailscale: HostEntryObservation['tailscale'] = 'unknown';
    let serve: HostEntryObservation['serve'] = 'unknown';
    const notes: string[] = [];
    try {
      const status = await runner('tailscale', ['status', '--json'], timeoutMs);
      if (status.code !== 0) notes.push(`tailscale status 退出码 ${status.code}`);
      else {
        const parsed: unknown = JSON.parse(status.stdout);
        const backend = typeof parsed === 'object' && parsed !== null && 'BackendState' in parsed ? (parsed as { BackendState?: unknown }).BackendState : undefined;
        if (backend === 'Running') tailscale = 'up';
        else if (backend === 'Stopped') tailscale = 'down';
        else notes.push('tailscale 未给出可识别的 BackendState');
      }
    } catch (error) {
      notes.push(`tailscale status 不可用：${describe(error)}`);
    }
    try {
      const served = await runner('tailscale', ['serve', 'status'], timeoutMs);
      if (served.code !== 0) notes.push(`tailscale serve status 退出码 ${served.code}`);
      else {
        const text = served.stdout.trim();
        serve = text === '' || /no serve config/i.test(text) ? 'off' : 'on';
      }
    } catch (error) {
      notes.push(`tailscale serve status 不可用：${describe(error)}`);
    }
    return { tailscale, serve, detail: notes.length > 0 ? notes.join('；') : `tailscale=${tailscale}；serve=${serve}` };
  }

  return {
    kind: 'windows-service',
    async diagnose(): Promise<HostDiagnostics> {
      const at = Date.now();
      const observations: HostServiceObservation[] = [];
      for (const id of HOST_SERVICES) {
        const name = services.get(id);
        if (name === undefined) {
          observations.push({ id, known: false, running: null, detail: '未预注册 Windows 服务', observedAt: at });
          continue;
        }
        observations.push(await probe(id, name, at));
      }
      return { kind: 'windows-service', observedAt: at, services: observations, entry: await diagnoseEntry() };
    },

    async action(request): Promise<HostActionResult> {
      const at = Date.now();
      if (!HOST_SERVICES.includes(request.service)) {
        return { accepted: false, observedAt: at, detail: `未预注册服务：${String(request.service)}`, basis: 'request-only' };
      }
      const name = services.get(request.service);
      if (name === undefined) {
        return { accepted: false, observedAt: at, detail: `动作未预注册：${request.service} 没有配置 Windows 服务名`, basis: 'request-only' };
      }
      if (!HOST_ACTIONS.includes(request.action)) {
        return { accepted: false, observedAt: at, detail: `未预注册动作：${String(request.action)}`, basis: 'request-only' };
      }
      if (request.action === 'status') {
        const observation = await probe(request.service, name, at);
        return { accepted: observation.running === true, observedAt: at, detail: observation.detail, basis: 'observation' };
      }
      // 契约只有 restart / reload：Windows 服务没有 reload，reload 按 Restart 处理并写明。
      const note = request.action === 'reload' ? '（Windows 服务无 reload，按 Restart 执行）' : '';
      try {
        const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle Hidden', '-Command', deriveScript(name)], timeoutMs);
        if (result.code !== 0) {
          return {
            accepted: false,
            observedAt: at,
            detail: `派生重启失败（退出码 ${result.code}）：${firstLine(result.stderr) || '无错误输出'}`,
            basis: 'request-only',
          };
        }
        return {
          accepted: true,
          observedAt: at,
          detail: `已派生独立重启进程（Restart-Service ${name}）${note}，结果由下次观测确认`,
          basis: 'request-only',
        };
      } catch (error) {
        return { accepted: false, observedAt: at, detail: `派生重启未能执行：${describe(error)}`, basis: 'request-only' };
      }
    },
  };
}
