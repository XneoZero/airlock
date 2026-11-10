/**
 * 发布上下文：一次服务器进程只加载一份配置，所有 op 共享它。
 * app 解析集中在这里，避免每个 op 各自实现一遍「id 存在性 + 缺省唯一应用」的规则。
 */
import type { AppConfig, DeployerConfig } from './contracts.ts';
import { DeployError } from './errors.ts';

/** 只暴露「按字节读」这一个能力：install 之外的 op 拿不到输入流。 */
export interface ArchiveReceiver {
  readBytes(n: number): Promise<Buffer>;
}

export interface DeployContext {
  readonly config: DeployerConfig;
  readonly clock: () => number;
  readonly kind: 'linux' | 'windows';
  /** 服务器侧配置文件的绝对路径。改落点要写回它；没传就拒绝改。 */
  readonly configPath?: string;
}

export function createContext(
  config: DeployerConfig,
  clock: () => number = () => Date.now(),
  configPath?: string,
): DeployContext {
  return {
    config,
    clock,
    kind: config.kind ?? (process.platform === 'win32' ? 'windows' : 'linux'),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

export function appIds(ctx: DeployContext): string[] {
  return Object.keys(ctx.config.apps).sort();
}

/**
 * 解析应用：不给 id 时只有「配置里恰好一个应用」才自动选中，
 * 多个应用必须显式指定——猜错目标比报错危险得多。
 */
export function appOf(ctx: DeployContext, appId: unknown): AppConfig {
  const ids = appIds(ctx);
  if (typeof appId !== 'string' || appId === '') {
    if (ids.length === 1) return ctx.config.apps[ids[0]!]!;
    throw new DeployError('INVALID_REQUEST', '需要指定 app（配置里有多个应用）', { apps: ids.join(',') });
  }
  const app = ctx.config.apps[appId];
  if (app === undefined) throw new DeployError('APP_NOT_FOUND', `未配置的应用：${appId}`, { apps: ids.join(',') });
  return app;
}
