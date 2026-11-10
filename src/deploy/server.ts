/**
 * Broker 路由：op → 实现，统一错误映射，统一响应编码。
 *
 * 未预期异常只回 INTERNAL：发布通道对端是长连接里的 SSH 进程，
 * 把服务器路径与堆栈发出去既没用又不安全。
 */
import { DEPLOY_PROTOCOL, type DeployRequest, type DeployResponse } from './contracts.ts';
import { appOf, type ArchiveReceiver, type DeployContext } from './context.ts';
import { DeployError, isDeployError, messageOf } from './errors.ts';
import { activateVersion, installVersion, rollbackVersion } from './operations.ts';
import { listOfApp, logsOfApp, pruneReleases, statusAll, statusOfApp } from './inspect.ts';

function errorResponse(id: number, code: DeployError['code'] | 'INTERNAL', message: string, detail?: DeployError['detail']): DeployResponse {
  return {
    v: DEPLOY_PROTOCOL, id, ok: false,
    error: { code, message: message.slice(0, 300), ...(detail === undefined ? {} : { detail }) },
  };
}

async function route(ctx: DeployContext, request: DeployRequest, reader: ArchiveReceiver): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.op) {
    case 'status':
      return request.app === undefined ? statusAll(ctx) : statusOfApp(ctx, request.app, params.probe === true);
    case 'list':
      return listOfApp(ctx, request.app);
    case 'logs':
      return logsOfApp(ctx, request.app, params.lines);
    case 'install': {
      const app = appOf(ctx, request.app);
      const merged = { ...params, archiveSize: request.archiveSize ?? params.archiveSize };
      return installVersion(ctx, app, merged, reader);
    }
    case 'activate': {
      const app = appOf(ctx, request.app);
      const result = await activateVersion(ctx, app, params);
      // 激活成功后按保留数清理旧目录；清理失败不能影响已完成的发布。
      await pruneReleases(ctx, request.app, app.keepReleases).catch(() => undefined);
      return result;
    }
    case 'rollback': {
      const app = appOf(ctx, request.app);
      return rollbackVersion(ctx, app, params);
    }
    default: {
      const never: never = request.op;
      throw new DeployError('INVALID_REQUEST', `未知 op：${String(never)}`);
    }
  }
}

export async function handleRequest(ctx: DeployContext, request: DeployRequest, reader: ArchiveReceiver): Promise<DeployResponse> {
  try {
    const data = await route(ctx, request, reader);
    return { v: DEPLOY_PROTOCOL, id: request.id, ok: true, data };
  } catch (error) {
    if (isDeployError(error)) return errorResponse(request.id, error.code, error.message, error.detail);
    return errorResponse(request.id, 'INTERNAL', '部署器内部错误');
  }
}

export { messageOf };
