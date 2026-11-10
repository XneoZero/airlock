/**
 * systemd 宿主运行时：状态只认 `systemctl is-active` 的输出，动作只认预注册单元。
 *
 * 为什么不接受请求里带单元名：一旦把 `service` 当字符串拼进命令行，`core; rm -rf /` 就会变成
 * 命令注入。这里只认 `HOST_SERVICES` 这个封闭集合的 id，单元名只从部署配置里来，并且再过一遍
 * `UNIT_NAME` 白名单——配置写错也应该在启动期被拒绝，而不是等到某次重启才炸。
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

/** systemd 单元名的保守白名单：够用（含 @ 模板单元），且不可能被 shell 当成语法。 */
const UNIT_NAME = /^[A-Za-z0-9._@-]{1,80}$/;
/** 单次命令输出上限：tailscale status --json 正常只有几 KB，超量说明命令行为异常，截断保命。 */
const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

type Runner = NonNullable<HostRuntimeConfig['runner']>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 只取第一行：stderr 常带整段堆栈，塞进 detail 会把诊断视图撑爆。 */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * 默认执行器：`shell:false` + 参数数组，不经 shell 解析；超时 kill；输出有界。
 * 非零退出不 reject——`is-active` 用退出码 3 表示 inactive，那是**有效观测**不是执行失败。
 */
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

/**
 * `is-active` 的已知状态映射。未列出的状态回 `null`（unknown）：
 * 认不出的输出说明 systemd 行为已经变了，猜成 false 会误报「服务已停止」。
 */
function mapIsActive(state: string): boolean | null {
  if (state === 'active' || state === 'activating' || state === 'reloading') return true;
  if (state === 'inactive' || state === 'failed' || state === 'deactivating') return false;
  return null;
}

export function createSystemdRuntime(config: HostRuntimeConfig): HostRuntimePort {
  const runner = config.runner ?? createDefaultRunner();
  const timeoutMs = Math.max(200, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const units = new Map<HostServiceId, string>();
  for (const id of HOST_SERVICES) {
    const unit = config.services?.[id];
    if (unit === undefined) continue;
    if (typeof unit !== 'string' || !UNIT_NAME.test(unit)) {
      throw new Error(`host-runtime: 服务 ${id} 的 systemd 单元名不合法（只允许 A-Za-z0-9._@-，1..80 字符）`);
    }
    units.set(id, unit);
  }

  async function probe(id: HostServiceId, unit: string, at: number): Promise<HostServiceObservation> {
    try {
      const result = await runner('systemctl', ['is-active', unit], timeoutMs);
      const state = result.stdout.trim().split(/\s+/)[0] ?? '';
      const running = mapIsActive(state);
      const suffix = running === null ? `（退出码 ${result.code}${result.stderr.trim() === '' ? '' : `：${firstLine(result.stderr)}`}）` : '';
      return { id, known: true, running, detail: `systemctl is-active ${unit}: ${state === '' ? '无输出' : state}${suffix}`, observedAt: at };
    } catch (error) {
      return { id, known: true, running: null, detail: `无法读取 ${unit} 状态：${describe(error)}`, observedAt: at };
    }
  }

  /**
   * 入口诊断。两个命令各自失败都只降级成 `unknown` 并写原因：
   * tailscale 未安装、serve 未开、DNS 未就绪都是正常状态，不能抛异常也不能猜 down/off。
   */
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
    kind: 'systemd',
    async diagnose(): Promise<HostDiagnostics> {
      const at = Date.now();
      const services: HostServiceObservation[] = [];
      for (const id of HOST_SERVICES) {
        const unit = units.get(id);
        if (unit === undefined) {
          services.push({ id, known: false, running: null, detail: '未预注册 systemd 单元', observedAt: at });
          continue;
        }
        services.push(await probe(id, unit, at));
      }
      return { kind: 'systemd', observedAt: at, services, entry: await diagnoseEntry() };
    },

    async action(request): Promise<HostActionResult> {
      const at = Date.now();
      if (!HOST_SERVICES.includes(request.service)) {
        return { accepted: false, observedAt: at, detail: `未预注册服务：${String(request.service)}`, basis: 'request-only' };
      }
      const unit = units.get(request.service);
      if (unit === undefined) {
        return { accepted: false, observedAt: at, detail: `动作未预注册：${request.service} 没有配置 systemd 单元`, basis: 'request-only' };
      }
      if (!HOST_ACTIONS.includes(request.action)) {
        return { accepted: false, observedAt: at, detail: `未预注册动作：${String(request.action)}`, basis: 'request-only' };
      }
      if (request.action === 'status') {
        // status 是只读动作：accepted 的含义收窄成「观测到它在跑」，避免调用方把它当写动作成功。
        const observation = await probe(request.service, unit, at);
        return { accepted: observation.running === true, observedAt: at, detail: observation.detail, basis: 'observation' };
      }
      const verb = request.action;
      try {
        // --no-block：重启 Core 自己时 systemctl 与 Core 同 cgroup，systemd 拆单元会把 systemctl
        // 一起杀掉，同步等待的重启只会做到一半。排队后立即返回，真实结果由下次启动的
        // reconcileBoot 收敛；因此这里只能给 request-only，不能假装观测到新状态。
        const result = await runner('systemctl', ['--no-block', verb, unit], timeoutMs);
        if (result.code !== 0) {
          return {
            accepted: false,
            observedAt: at,
            detail: `systemctl --no-block ${verb} ${unit} 退出码 ${result.code}：${firstLine(result.stderr) || '无错误输出'}`,
            basis: 'request-only',
          };
        }
        return {
          accepted: true,
          observedAt: at,
          detail: `已排队 systemctl --no-block ${verb} ${unit}，本进程可能即将重启，结果由下次启动确认`,
          basis: 'request-only',
        };
      } catch (error) {
        return { accepted: false, observedAt: at, detail: `systemctl ${verb} 未能执行：${describe(error)}`, basis: 'request-only' };
      }
    },
  };
}
