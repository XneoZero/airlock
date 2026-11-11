/**
 * 只读视图：status / list / logs。这三个 op 不改任何状态，
 * 但都要如实区分「记录说是什么」和「磁盘上实际是什么」。
 */
import { readFile, readdir } from 'node:fs/promises';
import { arch, hostname, release, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { appIds, appOf, type DeployContext } from './context.ts';
import { hasBackup } from './backup.ts';
import { currentVersionOnDisk, readState, releaseDir, releasesDir, tailLog } from './state.ts';
import { statusApp, waitHealthy } from './runtime.ts';

async function releaseDirsOnDisk(root: string): Promise<string[]> {
  try {
    const items = await readdir(releasesDir(root), { withFileTypes: true });
    return items.filter(item => item.isDirectory() && !item.name.endsWith('.tmp')).map(item => item.name).sort();
  } catch {
    return [];
  }
}

export async function statusOfApp(ctx: DeployContext, appId: unknown, probe: boolean): Promise<unknown> {
  const app = appOf(ctx, appId);
  const [state, onDisk, dirs] = await Promise.all([
    readState(app.root), currentVersionOnDisk(app.root), releaseDirsOnDisk(app.root),
  ]);
  const currentRecord = onDisk === null ? null : state.history.find(item => item.version === onDisk) ?? null;

  let health: { ok: boolean; detail: string } | null = null;
  if (probe && onDisk !== null) {
    const outcome = await waitHealthy(app.root, app.health === undefined ? undefined : { ...app.health, timeoutMs: Math.min(app.health.timeoutMs ?? 5000, 5000), intervalMs: 200 });
    health = { ok: outcome.ok, detail: outcome.detail };
  }
  const status = await statusApp(app.root, app.runtime.status);

  return {
    app: appId,
    serverId: ctx.config.serverId,
    kind: ctx.kind,
    root: app.root,
    current: onDisk,
    stateCurrent: state.current,
    consistent: onDisk === state.current,
    currentRecord,
    releasesOnDisk: dirs,
    history: state.history.slice(-10),
    health,
    status: status.detail,
    backup: onDisk === null ? null : await hasBackup(app.root, onDisk),
  };
}

export async function statusAll(ctx: DeployContext): Promise<unknown> {
  const ids = appIds(ctx);
  const apps = [];
  for (const id of ids) apps.push(await statusOfApp(ctx, id, false));
  return { serverId: ctx.config.serverId, kind: ctx.kind, apps };
}

export async function listOfApp(ctx: DeployContext, appId: unknown): Promise<unknown> {
  const app = appOf(ctx, appId);
  const [state, onDisk, dirs] = await Promise.all([
    readState(app.root), currentVersionOnDisk(app.root), releaseDirsOnDisk(app.root),
  ]);
  const releases = dirs.map(version => {
    const record = state.history.find(item => item.version === version) ?? null;
    return {
      version,
      current: version === onDisk,
      status: record?.status ?? 'unknown',
      createdAt: record?.createdAt ?? null,
      activatedAt: record?.activatedAt ?? null,
      fileCount: record?.fileCount ?? null,
      bytes: record?.bytes ?? null,
      commit: record?.commit ?? null,
      dir: releaseDir(app.root, version),
    };
  });
  return { app: appId, current: onDisk, releases, history: state.history };
}

export async function logsOfApp(ctx: DeployContext, appId: unknown, lines: unknown): Promise<unknown> {
  const app = appOf(ctx, appId);
  const count = typeof lines === 'number' && Number.isFinite(lines) ? Math.min(Math.max(1, Math.floor(lines)), 500) : 50;
  const tail = await tailLog(app.root, count);
  const current = await currentVersionOnDisk(app.root);
  const status = await statusApp(app.root, app.runtime.status);
  return { app: appId, current, lines: tail, status: status.detail, releases: await releaseDirsOnDisk(app.root) };
}

/** 删掉超出保留数的旧版本目录（只删目录，不删历史记录与备份）。 */
export async function pruneReleases(ctx: DeployContext, appId: unknown, keepOverride?: unknown): Promise<unknown> {
  const app = appOf(ctx, appId);
  const keep = typeof keepOverride === 'number' && Number.isFinite(keepOverride)
    ? Math.min(Math.max(1, Math.floor(keepOverride)), 50)
    : app.keepReleases ?? 5;
  const current = await currentVersionOnDisk(app.root);
  const dirs = await releaseDirsOnDisk(app.root);
  // 保留最新的 N 个，但当前在用的那个永远不删，哪怕它已经很旧。
  const ordered = [...dirs].sort();
  const keepers = new Set(ordered.slice(-keep));
  if (current !== null) keepers.add(current);
  const removed: string[] = [];
  const { rm } = await import('node:fs/promises');
  for (const version of ordered) {
    if (keepers.has(version)) continue;
    await rm(join(releasesDir(app.root), version), { recursive: true, force: true });
    removed.push(version);
  }
  return { app: appId, keep, removed, kept: [...keepers].sort() };
}

/**
 * 服务器自己的系统信息：只读，不碰应用目录。
 *
 * `status` 里的 `kind` 只说 Linux/Windows，排障时不够用——「端口通了但服务没起来」
 * 常常要先确认是不是同一台机器、是不是同一个 Node 版本。这些信息客户端拿不到，
 * 只能由服务器侧报上来。
 */
async function readOsRelease(): Promise<{ id: string; version: string; pretty: string } | null> {
  let text: string;
  try {
    text = await readFile('/etc/os-release', 'utf8');
  } catch {
    return null; // Windows 和极简镜像没有这个文件
  }
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    fields.set(match[1]!, match[2]!.replace(/^"(.*)"$/, '$1'));
  }
  const pretty = fields.get('PRETTY_NAME') ?? fields.get('NAME');
  if (pretty === undefined || pretty === '') return null;
  return { id: fields.get('ID') ?? '', version: fields.get('VERSION_ID') ?? '', pretty };
}

export async function sysinfoOfServer(ctx: DeployContext): Promise<unknown> {
  const distro = ctx.kind === 'linux' ? await readOsRelease() : null;
  return {
    serverId: ctx.config.serverId,
    kind: ctx.kind,
    platform: process.platform,
    arch: arch(),
    kernel: release(),
    hostname: hostname(),
    node: process.version,
    // Windows 没有 os-release：退回内核版本，总比空着强。
    osName: distro?.pretty ?? osVersion(),
    osVersion: distro?.version ?? null,
  };
}

