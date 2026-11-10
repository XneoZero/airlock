/**
 * 宿主运行时装配：按 `kind` 选实现，配置为空时降级成 `none`。
 *
 * 为什么「services 为空也降级成 none」：`kind` 是部署目标，`services` 是本机真正预注册的单元。
 * 一旦 kind=systemd 而一个单元都没登记，任何动作都只能失败；继续报 systemd 会让上层以为本机
 * 有可操作面，发布管理器也会把「动作未预注册」误读成「服务异常」。降级成 none 才是事实。
 *
 * `none` 实现同样保持端口契约：不抛错、不伪造成功。缺少实现时抛异常会让客户端状态页整页失败，
 * 而这里正确的语义是「本机不管服务」。
 */
import { HOST_SERVICES } from '../../contracts/remote.ts';
import { createSystemdRuntime } from './systemd.ts';
import { createWindowsRuntime } from './windows.ts';
import type { HostActionResult, HostDiagnostics, HostRuntimeConfig, HostRuntimePort } from './types.ts';

function hasRegisteredService(config: HostRuntimeConfig): boolean {
  if (config.services === undefined) return false;
  return HOST_SERVICES.some(id => {
    const value = config.services?.[id];
    return typeof value === 'string' && value.trim() !== '';
  });
}

/** 降级实现：全部 known=false / running=null，动作一律「未预注册」。 */
function createNoneRuntime(): HostRuntimePort {
  return {
    kind: 'none',
    async diagnose(): Promise<HostDiagnostics> {
      const at = Date.now();
      return {
        kind: 'none',
        observedAt: at,
        services: HOST_SERVICES.map(id => ({
          id,
          known: false,
          running: null,
          detail: '本机未托管该服务（kind=none 或未预注册单元）',
          observedAt: at,
        })),
        // 没有服务管理就没有入口证据：null 比伪造一个 unknown 快照更诚实。
        entry: null,
      };
    },
    async action(request): Promise<HostActionResult> {
      return {
        accepted: false,
        observedAt: Date.now(),
        detail: `动作未预注册：本机不托管服务（${String(request.service)}/${String(request.action)}）`,
        basis: 'request-only',
      };
    },
  };
}

export function createHostRuntime(config: HostRuntimeConfig): HostRuntimePort {
  // 未知 kind 一律按 none：配置损坏时宁可「什么都不能做」，也不能挑一个实现去猜。
  switch (config.kind) {
    case 'systemd':
      return hasRegisteredService(config) ? createSystemdRuntime(config) : createNoneRuntime();
    case 'windows-service':
      return hasRegisteredService(config) ? createWindowsRuntime(config) : createNoneRuntime();
    default:
      return createNoneRuntime();
  }
}

export type { HostActionResult, HostDiagnostics, HostEntryObservation, HostRuntimeConfig, HostRuntimePort, HostServiceObservation } from './types.ts';
