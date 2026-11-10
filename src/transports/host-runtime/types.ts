/**
 * 宿主运行时端口：把「观测」与「动作」分成两层。
 *
 * 为什么把观测与动作拆成两个层次：
 * - `diagnose()` 回报的是「证据」而不是布尔开关。`running:null` 表示**没有证据**（探测失败/超时/
 *   本机不管理该服务），与 `running:false`（明确已停止）不是一回事。上层据此把状态标成
 *   `unknown` 而不是 `offline`，避免把一次探测失败推断成服务退出。
 * - `action()` 回报 `basis`：`observation` 表示动作后重新观测过，`request-only` 表示只拿到了
 *   「请求已提交」这个事实。发布管理器不能用 request-only 冒充重启成功。
 *
 * 本文件只是形状，不含 IO；实现按 `kind` 选 systemd / windows-service / none。
 * 依赖方向：transports 层只依赖 contracts，不 import kernel / domains。
 */
import type { HostServiceId, HostActionId } from '../../contracts/remote.ts';

/** 单个预注册服务的观测。`known` 指「本机配置里有没有它」，不是「服务是否存在」。 */
export interface HostServiceObservation {
  readonly id: HostServiceId;
  readonly known: boolean;
  readonly running: boolean | null;
  readonly detail: string;
  readonly observedAt: number;
}

/** 入口（tailscale / serve）观测。三项都可以是 `unknown`：读不到就不猜。 */
export interface HostEntryObservation {
  readonly tailscale: 'up' | 'down' | 'unknown';
  readonly serve: 'on' | 'off' | 'unknown';
  readonly detail: string;
}

/** 一次完整诊断快照。`observedAt` 是采集时刻，不是缓存命中时刻。 */
export interface HostDiagnostics {
  readonly kind: 'systemd' | 'windows-service' | 'none';
  readonly observedAt: number;
  readonly services: readonly HostServiceObservation[];
  readonly entry: HostEntryObservation | null;
}

/**
 * 动作结果。`accepted` 只表示「宿主接受了这个请求」，**不代表服务已经恢复**；
 * 服务是否真的起来只能看下一次 `diagnose()`。
 */
export interface HostActionResult {
  readonly accepted: boolean;
  readonly observedAt: number;
  readonly detail: string;
  readonly basis: 'observation' | 'request-only';
}

/**
 * 宿主运行时端口。实现必须遵守：
 * 1. 只接受 `HOST_SERVICES` 里的 id，绝不把名字当命令行参数拼接（注入面）；
 * 2. 探测失败不抛异常、不伪造 running；
 * 3. `action()` 对未预注册的服务返回 `accepted:false`，不是抛错（调用方要能展示原因）。
 */
export interface HostRuntimePort {
  readonly kind: 'systemd' | 'windows-service' | 'none';
  diagnose(): Promise<HostDiagnostics>;
  action(request: { readonly service: HostServiceId; readonly action: HostActionId }): Promise<HostActionResult>;
}

/**
 * 运行时配置。
 * - `services` 是「逻辑 id → 单元名/服务名」的预注册表；**这里是唯一允许出现服务名的地方**，
 *   请求侧只能给 id。
 * - `runner` 供测试注入，生产默认 spawn；签名固定为 `(file, args, timeoutMs)`，方便断言
 *   实际执行了什么命令、有没有把用户输入拼进去。
 */
export interface HostRuntimeConfig {
  readonly kind: 'systemd' | 'windows-service' | 'none';
  readonly services?: Partial<Record<HostServiceId, string>>;
  readonly timeoutMs?: number;
  readonly runner?: (file: string, args: readonly string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number }>;
}
