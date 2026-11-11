/**
 * 发布动作：install（收包解压）/ activate（切换并起服务）/ rollback（切回旧版本）。
 *
 * 关键顺序（顺序错了就是事故）：
 * 1. install 先解到 `<version>.tmp` 再 rename：解压中途失败不会留下一个「看起来存在」的半截版本。
 * 2. activate 先 stop、再切链接、再 start：服务停机窗口内 current 已经指向新版本，不会读到混合状态。
 * 3. 起不来就切回上一个版本并把它拉起来，然后如实报失败——服务不能因为一次发布停在停止态。
 */
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { symlink, lstat, rmdir, unlink } from 'node:fs/promises';
import type { AppConfig, ReleaseRecord } from './contracts.ts';
import { VERSION_RE } from './contracts.ts';
import { manifestOfDirectory, unpackArchive } from './archive.ts';
import { createBackup, restoreBackup } from './backup.ts';
import { DeployError, messageOf } from './errors.ts';
import { runCommand, startApp, stopApp, waitHealthy, waitPortReleased } from './runtime.ts';
import {
  appendLog, currentLink, currentVersionOnDisk, ensureAppDirs, findRecord, incomingDir,
  previousDeployed, readState, releaseDir, releasesDir, setCurrent, upsertRecord, writeState,
} from './state.ts';
import type { DeployContext, ArchiveReceiver } from './context.ts';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function requireVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) {
    throw new DeployError('VERSION_INVALID', '版本号不合法（1-64 位字母数字与 . _ -）');
  }
  return value;
}

/** 切链接：先删旧链接（可能是符号链接或 junction），再指向新版本目录。 */
async function switchCurrent(root: string, version: string): Promise<void> {
  const link = currentLink(root);
  const info = await lstat(link).catch(() => null);
  if (info !== null) {
    if (info.isSymbolicLink()) await unlink(link).catch(() => rmdir(link).catch(() => undefined));
    else if (info.isDirectory()) await rmdir(link);
    else await unlink(link);
  }
  const target = resolve(releasesDir(root), version);
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await appendLog(root, `current -> releases/${version}`);
}

/** 把请求头里声明的字节数写进临时文件，返回落盘大小。超限中途即失败，不等到写完。 */
export async function receiveArchive(receiver: ArchiveReceiver, size: number, target: string): Promise<number> {
  await mkdir(resolve(target, '..'), { recursive: true });
  const stream = createWriteStream(target);
  let written = 0;
  try {
    while (written < size) {
      const chunk = await receiver.readBytes(Math.min(size - written, 64 * 1024));
      await new Promise<void>((done, fail) => {
        stream.write(chunk, error => (error ? fail(error) : done()));
      });
      written += chunk.length;
    }
  } finally {
    await new Promise<void>(done => stream.end(() => done()));
  }
  return written;
}

export async function installVersion(ctx: DeployContext, app: AppConfig, params: Record<string, unknown>, receiver: ArchiveReceiver): Promise<unknown> {
  await ensureAppDirs(app.root);
  const version = requireVersion(params.version);
  const archiveSize = typeof params.archiveSize === 'number' ? params.archiveSize : -1;
  const maxBytes = ctx.config.maxArchiveBytes ?? 536_870_912;
  if (archiveSize < 0) throw new DeployError('INVALID_REQUEST', 'install 需要 archiveSize');
  if (archiveSize > maxBytes) throw new DeployError('ARCHIVE_TOO_LARGE', `归档超过上限 ${maxBytes} 字节`, { archiveSize, maxBytes });

  const finalDir = releaseDir(app.root, version);
  if (await exists(finalDir)) throw new DeployError('VERSION_EXISTS', `版本目录已存在：${version}`);

  await Promise.all([ensureAppDirs(app.root), mkdir(incomingDir(app.root), { recursive: true })]);
  const incoming = join(incomingDir(app.root), `${version}-${Date.now()}.tar.gz`);
  try {
    const written = await receiveArchive(receiver, archiveSize, incoming);
    if (written !== archiveSize) throw new DeployError('ARCHIVE_INVALID', '归档字节数与声明不一致', { written, archiveSize });

    const staging = `${finalDir}.tmp`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    let manifest;
    try {
      manifest = await unpackArchive({ archive: incoming, destDir: staging, maxBytes });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw new DeployError('ARCHIVE_INVALID', `解压失败：${messageOf(error)}`);
    }

    const expected = typeof params.manifestHash === 'string' ? params.manifestHash : null;
    if (expected !== null && expected !== manifest.totalHash) {
      await rm(staging, { recursive: true, force: true });
      throw new DeployError('MANIFEST_MISMATCH', '解压后内容摘要与本机清单不一致（传输出错或包被改过）', {
        expected, actual: manifest.totalHash,
      });
    }

    if (app.install !== undefined) {
      const result = await runCommand({ root: app.root, command: app.install, cwdOverride: staging });
      if (result.code !== 0) {
        await rm(staging, { recursive: true, force: true });
        throw new DeployError('INSTALL_FAILED', `准备命令失败（退出码 ${result.code}）：${result.stderr.trim().split(/\r?\n/)[0] ?? ''}`);
      }
    }

    await rename(staging, finalDir);
    const state = await readState(app.root);
    const record: ReleaseRecord = {
      version, manifestHash: manifest.totalHash, fileCount: manifest.files.length, bytes: manifest.bytes,
      commit: typeof params.commit === 'string' ? params.commit.slice(0, 64) : null,
      status: 'installed', createdAt: ctx.clock(), activatedAt: null, backup: null, note: '',
    };
    await writeState(app.root, upsertRecord(state, record));
    await appendLog(app.root, `install ${version}（${manifest.files.length} 文件 / ${manifest.bytes} 字节）`);
    return { version, manifestHash: manifest.totalHash, fileCount: manifest.files.length, bytes: manifest.bytes };
  } finally {
    await rm(incoming, { force: true }).catch(() => undefined);
  }
}

export async function activateVersion(ctx: DeployContext, app: AppConfig, params: Record<string, unknown>): Promise<unknown> {
  await ensureAppDirs(app.root);
  let state = await readState(app.root);
  const version = requireVersion(params.version ?? state.current);
  const dir = releaseDir(app.root, version);
  if (!(await exists(dir))) throw new DeployError('VERSION_NOT_FOUND', `版本目录不存在：${version}`);

  const onDisk = await currentVersionOnDisk(app.root);
  const existing = findRecord(state, version);
  if (onDisk === version && existing?.status === 'deployed') {
    return { version, replayed: true, previous: null, health: { ok: true, detail: '已是当前版本，未重复激活' } };
  }
  // 没有 install 记录就不允许激活：内容摘要、文件数、备份归属都挂在那条记录上。
  if (existing === null) throw new DeployError('VERSION_NOT_FOUND', `版本 ${version} 没有安装记录，请先 install`);
  const previous = onDisk;

  // 备份在 stop 之前：先把「现在正在用的数据」固定下来，再停服务。
  const backup = await createBackup(app.root, version, app.backupPaths ?? []);

  const stop = await stopApp(app.root, app.runtime.stop);
  await appendLog(app.root, `stop：${stop.detail}`);

  // 停完先确认端口真的空了，再动 current。没空就说明旧进程还在跑：
  // 这时切过去，新进程会抢端口失败，而健康检查探到的还是旧进程——发布假成功。
  const released = await waitPortReleased(app.health);
  if (released !== null) {
    await appendLog(app.root, `端口检查：${released.detail}`);
    if (!released.ok) {
      await markFailed(ctx, app.root, version, `停止旧版本失败：${released.detail}`);
      throw new DeployError('STOP_FAILED', `${released.detail}；current 仍是 ${previous ?? '(无)'}，未切换`, {
        version,
        previous: previous ?? null,
      });
    }
  }

  await switchCurrent(app.root, version);

  state = setCurrent(state, version);
  state = upsertRecord(state, { ...existing, status: 'installed', backup: backup.path, note: '' });
  await writeState(app.root, state);

  const startOnActivate = app.startOnActivate !== false;
  if (startOnActivate) {
    const started = await startApp(app.root, app.runtime.start);
    if (!started.ok) {
      const recovered = await recoverPrevious(ctx, app, previous);
      await markFailed(ctx, app.root, version, `启动失败：${started.detail}`);
      throw new DeployError('START_FAILED', `${started.detail}${recovered}`, { version, previous: previous ?? null });
    }
  }

  const health = await waitHealthy(app.root, app.health);
  if (!health.ok) {
    const recovered = await recoverPrevious(ctx, app, previous);
    await markFailed(ctx, app.root, version, `健康检查失败：${health.detail}`);
    throw new DeployError('HEALTH_FAILED', `${health.detail}${recovered}`, { version, previous: previous ?? null });
  }

  await markDeployed(ctx, app.root, version);
  await appendLog(app.root, `activate ${version}：健康检查通过（${health.detail}）`);
  return {
    version, replayed: false, previous,
    health: { ok: true, detail: health.detail, attempts: health.attempts },
    backup: backup.path,
  };
}

/** 起不来时切回上一版并拉起来；没有上一版就保持现状，返回给调用方的说明文字。 */
async function recoverPrevious(ctx: DeployContext, app: AppConfig, previous: string | null): Promise<string> {
  if (previous === null) return '；没有上一版可回退，服务可能仍处于停止状态';
  try {
    await switchCurrent(app.root, previous);
    // 状态文件必须跟着回退，否则 status 会一直报「记录说新版本、磁盘是旧版本」。
    // 这个不一致本身就是信号：真出现了要去查是谁改了链接。
    const state = await readState(app.root);
    await writeState(app.root, setCurrent(state, previous));
    if (app.startOnActivate !== false) await startApp(app.root, app.runtime.start);
    await appendLog(app.root, `自动回退准备：current -> releases/${previous}`);
    return `；已自动切回 ${previous} 并重启`;
  } catch (error) {
    return `；自动回退 ${previous} 也失败了：${messageOf(error)}`;
  }
}

async function markDeployed(ctx: DeployContext, root: string, version: string): Promise<void> {
  const state = await readState(root);
  const record = findRecord(state, version);
  if (record === null) return;
  await writeState(root, upsertRecord(state, { ...record, status: 'deployed', activatedAt: ctx.clock() }));
}

async function markFailed(ctx: DeployContext, root: string, version: string, note: string): Promise<void> {
  const state = await readState(root);
  const record = findRecord(state, version);
  if (record === null) return;
  await writeState(root, upsertRecord(state, { ...record, status: 'failed', note: note.slice(0, 300) }));
}

export async function rollbackVersion(ctx: DeployContext, app: AppConfig, params: Record<string, unknown>): Promise<unknown> {
  await ensureAppDirs(app.root);
  const state = await readState(app.root);
  const onDisk = await currentVersionOnDisk(app.root);
  const requested = typeof params.to === 'string' ? requireVersion(params.to) : null;
  const target = requested ?? previousDeployed(state, onDisk)?.version ?? null;
  if (target === null) throw new DeployError('NO_PREVIOUS_VERSION', '没有可回滚的上一版（历史里没有已部署记录）');
  if (target === onDisk) throw new DeployError('INVALID_REQUEST', `当前已经是 ${target}`);

  const dir = releaseDir(app.root, target);
  if (!(await exists(dir))) throw new DeployError('VERSION_NOT_FOUND', `目标版本目录不存在：${target}`);

  const stop = await stopApp(app.root, app.runtime.stop);
  await appendLog(app.root, `rollback 开始：${onDisk ?? '(无)'} -> ${target}；stop：${stop.detail}`);

  const released = await waitPortReleased(app.health);
  if (released !== null && !released.ok) {
    await appendLog(app.root, `端口检查失败：${released.detail}`);
    throw new DeployError('STOP_FAILED', `${released.detail}；current 仍是 ${onDisk ?? '(无)'}，未切换`, { version: target });
  }

  const restore = params.restoreBackup === true || app.restoreBackupOnRollback === true;
  let restored: string | null = null;
  if (restore) restored = await restoreBackup(app.root, target, app);

  await switchCurrent(app.root, target);
  let next = setCurrent(state, target);
  const old = onDisk === null ? null : findRecord(state, onDisk);
  if (old !== null) next = upsertRecord(next, { ...old, status: 'rolled_back', note: `回滚到 ${target}`.slice(0, 300) });
  await writeState(app.root, next);

  if (app.startOnActivate !== false) {
    const started = await startApp(app.root, app.runtime.start);
    if (!started.ok) throw new DeployError('START_FAILED', `${started.detail}`, { version: target });
  }
  const health = await waitHealthy(app.root, app.health);
  if (!health.ok) throw new DeployError('HEALTH_FAILED', `回滚后健康检查失败：${health.detail}`, { version: target });

  await appendLog(app.root, `rollback 完成：${target}（${health.detail}）`);
  return { from: onDisk, to: target, restored, health: { ok: true, detail: health.detail } };
}
