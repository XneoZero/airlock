/**
 * 发布动作：install（收包解压）/ activate（切换并起服务）/ rollback（切回旧版本）。
 *
 * 关键顺序（顺序错了就是事故）：
 * 1. install 先解到 `<version>.tmp` 再 rename：解压中途失败不会留下一个「看起来存在」的半截版本。
 * 2. activate 先 stop、再切链接、再 start：服务停机窗口内 current 已经指向新版本，不会读到混合状态。
 * 3. 起不来就切回上一个版本并把它拉起来，然后如实报失败——服务不能因为一次发布停在停止态。
 */
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { symlink, lstat, rmdir, unlink } from 'node:fs/promises';
import type { AppConfig, ReleaseRecord } from './contracts.ts';
import { VERSION_RE } from './contracts.ts';
import { manifestOfDirectory, unpackArchive } from './archive.ts';
import { createBackup, restoreBackup } from './backup.ts';
import { syncMirror } from './mirror.ts';
import { DeployError, messageOf } from './errors.ts';
import { runCommand, startApp, stopApp, waitHealthy, waitPortReleased } from './runtime.ts';
import {
  appendLog, currentLink, currentVersionOnDisk, ensureAppDirs, findRecord, incomingDir,
  previousDeployed, readState, releaseDir, releasesDir, setCurrent, stateRoot, upsertRecord, writeState,
  type AppLayout,
} from './state.ts';
import type { DeployContext, ArchiveReceiver } from './context.ts';

/** 落点布局；老配置没写 layout 就按 nested（root 下带 releases/current）。 */
function layoutOf(app: AppConfig): AppLayout {
  return app.layout ?? 'nested';
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function requireVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) {
    throw new DeployError('VERSION_INVALID', '版本号不合法（1-64 位字母数字与 . _ -）');
  }
  return value;
}

/** 切站点入口：nested 切 `<root>/current`，flat 直接切 root 本身。 */
async function switchCurrent(root: string, version: string, layout: AppLayout = 'nested'): Promise<void> {
  const state = stateRoot(root, layout);
  const link = currentLink(root, layout);
  const info = await lstat(link).catch(() => null);
  if (info !== null) {
    if (info.isSymbolicLink()) {
      await unlink(link).catch(() => rmdir(link).catch(() => undefined));
    } else if (layout === 'flat' && info.isDirectory()) {
      // 首次从 nested 切到 flat：root 还是老布局的实体目录（站点文件直接躺在里面）。
      // 整体挪进状态区保留，再从链接过去，不丢任何东西。
      const legacy = resolve(state, 'releases', `legacy-${Date.now()}`);
      await mkdir(resolve(legacy, '..'), { recursive: true });
      await rename(root, legacy);
    } else if (info.isDirectory()) {
      await rmdir(link);
    } else {
      await unlink(link);
    }
  }
  const target = resolve(releasesDir(state), version);
  await mkdir(resolve(link, '..'), { recursive: true });
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await appendLog(state, `current -> releases/${version}`);
}

/**
 * 把运行时数据留在版本之外：版本目录里的 `sharedPaths` 换成指向 `<root>/shared/<路径>` 的链接。
 *
 * 为什么必须有这一层：发布包解出来的是干净目录，而客户线索、上传的图片视频、
 * SQLite 库这些必须是「跨版本同一份」。靠 start hook 自己写 junction 能做，但每个应用都要
 * 重写一遍、还容易漏。配在 deployer.json 里，激活时统一处理。
 *
 * 首次发布时如果包里带了这些目录（打包忘了排除），会把内容并进 shared 而不是扔掉；
 * shared 已经有东西时，以 shared 为准，版本内那份直接丢弃并记一行日志。
 */
async function linkSharedPaths(root: string, versionDir: string, sharedPaths: readonly string[] | undefined): Promise<void> {
  if (sharedPaths === undefined || sharedPaths.length === 0) return;
  for (const raw of sharedPaths) {
    const parts = raw.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.');
    if (parts.length === 0) continue;
    const rel = parts.join('/');
    const target = join(root, 'shared', ...parts);
    const link = join(versionDir, ...parts);
    await mkdir(resolve(target, '..'), { recursive: true });

    const linkInfo = await lstat(link).catch(() => null);
    const targetInfo = await lstat(target).catch(() => null);

    if (targetInfo === null) {
      if (linkInfo !== null && linkInfo.isDirectory() && !linkInfo.isSymbolicLink()) {
        // 包里自带这份数据：把它整体变成 shared 的第一份，不复制、也不丢
        await rename(link, target);
        await appendLog(root, `shared/${rel}：由首个版本的目录迁移而来`);
      } else {
        await mkdir(target, { recursive: true });
      }
    } else if (linkInfo !== null && !linkInfo.isSymbolicLink()) {
      await rm(link, { recursive: true, force: true });
      await appendLog(root, `shared/${rel} 已存在，丢弃版本内的同名目录（以 shared 为准）`);
    }

    const current = await lstat(link).catch(() => null);
    if (current !== null) {
      if (current.isSymbolicLink()) await unlink(link).catch(() => rmdir(link).catch(() => undefined));
      else await rm(link, { recursive: true, force: true });
    }
    // 嵌套路径（assets/img）时，版本目录里可能连父目录都没有，先补出来
    await mkdir(resolve(link, '..'), { recursive: true });
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await appendLog(root, `shared 链接已就位：${sharedPaths.join('、')}`);
}

/** 激活/回滚共用：nested/flat 切入口，mirror 直接把内容同步到 root。 */
async function prepareVersion(root: string, version: string, sharedPaths: readonly string[] | undefined, layout: AppLayout = 'nested'): Promise<void> {
  const state = stateRoot(root, layout);
  if (layout === 'mirror') {
    // 没有版本目录/链接：把这次发布的内容镜像到 root，再把数据目录链回 shared。
    const result = syncMirror(resolve(releasesDir(state), version), root, sharedPaths ?? []);
    await linkSharedPaths(state, root, sharedPaths);
    await appendLog(state, `mirror 同步完成：写入 ${result.written} 个文件，删除 ${result.removed} 项`);
    return;
  }
  await switchCurrent(root, version, layout);
  await linkSharedPaths(state, resolve(releasesDir(state), version), sharedPaths);
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
  await ensureAppDirs(app.root, layoutOf(app));
  const version = requireVersion(params.version);
  const archiveSize = typeof params.archiveSize === 'number' ? params.archiveSize : -1;
  const maxBytes = ctx.config.maxArchiveBytes ?? 536_870_912;
  if (archiveSize < 0) throw new DeployError('INVALID_REQUEST', 'install 需要 archiveSize');
  if (archiveSize > maxBytes) throw new DeployError('ARCHIVE_TOO_LARGE', `归档超过上限 ${maxBytes} 字节`, { archiveSize, maxBytes });

  const finalDir = releaseDir(stateRoot(app.root, layoutOf(app)), version);
  if (await exists(finalDir)) throw new DeployError('VERSION_EXISTS', `版本目录已存在：${version}`);

  await Promise.all([ensureAppDirs(app.root, layoutOf(app)), mkdir(incomingDir(stateRoot(app.root, layoutOf(app))), { recursive: true })]);
  const incoming = join(incomingDir(stateRoot(app.root, layoutOf(app))), `${version}-${Date.now()}.tar.gz`);
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
    const state = await readState(stateRoot(app.root, layoutOf(app)));
    const record: ReleaseRecord = {
      version, manifestHash: manifest.totalHash, fileCount: manifest.files.length, bytes: manifest.bytes,
      commit: typeof params.commit === 'string' ? params.commit.slice(0, 64) : null,
      status: 'installed', createdAt: ctx.clock(), activatedAt: null, backup: null, note: '',
    };
    await writeState(stateRoot(app.root, layoutOf(app)), upsertRecord(state, record));
    await appendLog(stateRoot(app.root, layoutOf(app)), `install ${version}（${manifest.files.length} 文件 / ${manifest.bytes} 字节）`);
    return { version, manifestHash: manifest.totalHash, fileCount: manifest.files.length, bytes: manifest.bytes };
  } finally {
    await rm(incoming, { force: true }).catch(() => undefined);
  }
}

export async function activateVersion(ctx: DeployContext, app: AppConfig, params: Record<string, unknown>): Promise<unknown> {
  await ensureAppDirs(app.root, layoutOf(app));
  let state = await readState(stateRoot(app.root, layoutOf(app)));
  const version = requireVersion(params.version ?? state.current);
  const dir = releaseDir(stateRoot(app.root, layoutOf(app)), version);
  if (!(await exists(dir))) throw new DeployError('VERSION_NOT_FOUND', `版本目录不存在：${version}`);

  const onDisk = await currentVersionOnDisk(app.root, layoutOf(app));
  const existing = findRecord(state, version);
  if (onDisk === version && existing?.status === 'deployed') {
    return { version, replayed: true, previous: null, health: { ok: true, detail: '已是当前版本，未重复激活' } };
  }
  // 没有 install 记录就不允许激活：内容摘要、文件数、备份归属都挂在那条记录上。
  if (existing === null) throw new DeployError('VERSION_NOT_FOUND', `版本 ${version} 没有安装记录，请先 install`);
  const previous = onDisk;

  // 备份在 stop 之前：先把「现在正在用的数据」固定下来，再停服务。
  const backup = await createBackup(stateRoot(app.root, layoutOf(app)), version, app.backupPaths ?? []);

  const stop = await stopApp(app.root, app.runtime.stop, layoutOf(app));
  await appendLog(stateRoot(app.root, layoutOf(app)), `stop：${stop.detail}`);

  // 停完先确认端口真的空了，再动 current。没空就说明旧进程还在跑：
  // 这时切过去，新进程会抢端口失败，而健康检查探到的还是旧进程——发布假成功。
  const released = await waitPortReleased(app.health);
  if (released !== null) {
    await appendLog(stateRoot(app.root, layoutOf(app)), `端口检查：${released.detail}`);
    if (!released.ok) {
      await markFailed(ctx, app.root, version, `停止旧版本失败：${released.detail}`);
      throw new DeployError('STOP_FAILED', `${released.detail}；current 仍是 ${previous ?? '(无)'}，未切换`, {
        version,
        previous: previous ?? null,
      });
    }
  }

  await prepareVersion(app.root, version, app.sharedPaths, layoutOf(app));

  state = setCurrent(state, version);
  state = upsertRecord(state, { ...existing, status: 'installed', backup: backup.path, note: '' });
  await writeState(stateRoot(app.root, layoutOf(app)), state);

  const startOnActivate = app.startOnActivate !== false;
  if (startOnActivate) {
    const started = await startApp(app.root, app.runtime.start, layoutOf(app));
    if (!started.ok) {
      const recovered = await recoverPrevious(ctx, app, previous);
      await markFailed(ctx, app.root, version, `启动失败：${started.detail}`);
      throw new DeployError('START_FAILED', `${started.detail}${recovered}`, { version, previous: previous ?? null });
    }
  }

  const health = await waitHealthy(app.root, app.health, layoutOf(app));
  if (!health.ok) {
    const recovered = await recoverPrevious(ctx, app, previous);
    await markFailed(ctx, app.root, version, `健康检查失败：${health.detail}`);
    throw new DeployError('HEALTH_FAILED', `${health.detail}${recovered}`, { version, previous: previous ?? null });
  }

  await markDeployed(ctx, app.root, version);
  await appendLog(stateRoot(app.root, layoutOf(app)), `activate ${version}：健康检查通过（${health.detail}）`);
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
    await prepareVersion(app.root, previous, app.sharedPaths, layoutOf(app));
    // 状态文件必须跟着回退，否则 status 会一直报「记录说新版本、磁盘是旧版本」。
    // 这个不一致本身就是信号：真出现了要去查是谁改了链接。
    const state = await readState(stateRoot(app.root, layoutOf(app)));
    await writeState(stateRoot(app.root, layoutOf(app)), setCurrent(state, previous));
    if (app.startOnActivate !== false) await startApp(app.root, app.runtime.start, layoutOf(app));
    await appendLog(stateRoot(app.root, layoutOf(app)), `自动回退准备：current -> releases/${previous}`);
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
  if (layoutOf(app) === 'mirror') {
    throw new DeployError(
      'NO_PREVIOUS_VERSION',
      'mirror 布局不在服务器保留历史版本：回退请先 git checkout 到旧提交，再 release 一次',
    );
  }
  await ensureAppDirs(app.root, layoutOf(app));
  const state = await readState(stateRoot(app.root, layoutOf(app)));
  const onDisk = await currentVersionOnDisk(app.root, layoutOf(app));
  const requested = typeof params.to === 'string' ? requireVersion(params.to) : null;
  const target = requested ?? previousDeployed(state, onDisk)?.version ?? null;
  if (target === null) throw new DeployError('NO_PREVIOUS_VERSION', '没有可回滚的上一版（历史里没有已部署记录）');
  if (target === onDisk) throw new DeployError('INVALID_REQUEST', `当前已经是 ${target}`);

  const dir = releaseDir(stateRoot(app.root, layoutOf(app)), target);
  if (!(await exists(dir))) throw new DeployError('VERSION_NOT_FOUND', `目标版本目录不存在：${target}`);

  const stop = await stopApp(app.root, app.runtime.stop, layoutOf(app));
  await appendLog(stateRoot(app.root, layoutOf(app)), `rollback 开始：${onDisk ?? '(无)'} -> ${target}；stop：${stop.detail}`);

  const released = await waitPortReleased(app.health);
  if (released !== null && !released.ok) {
    await appendLog(stateRoot(app.root, layoutOf(app)), `端口检查失败：${released.detail}`);
    throw new DeployError('STOP_FAILED', `${released.detail}；current 仍是 ${onDisk ?? '(无)'}，未切换`, { version: target });
  }

  const restore = params.restoreBackup === true || app.restoreBackupOnRollback === true;
  let restored: string | null = null;
  if (restore) restored = await restoreBackup(stateRoot(app.root, layoutOf(app)), target, app);

  await prepareVersion(app.root, target, app.sharedPaths, layoutOf(app));
  let next = setCurrent(state, target);
  const old = onDisk === null ? null : findRecord(state, onDisk);
  if (old !== null) next = upsertRecord(next, { ...old, status: 'rolled_back', note: `回滚到 ${target}`.slice(0, 300) });
  await writeState(stateRoot(app.root, layoutOf(app)), next);

  if (app.startOnActivate !== false) {
    const started = await startApp(app.root, app.runtime.start, layoutOf(app));
    if (!started.ok) throw new DeployError('START_FAILED', `${started.detail}`, { version: target });
  }
  const health = await waitHealthy(app.root, app.health, layoutOf(app));
  if (!health.ok) throw new DeployError('HEALTH_FAILED', `回滚后健康检查失败：${health.detail}`, { version: target });

  await appendLog(stateRoot(app.root, layoutOf(app)), `rollback 完成：${target}（${health.detail}）`);
  return { from: onDisk, to: target, restored, health: { ok: true, detail: health.detail } };
}
