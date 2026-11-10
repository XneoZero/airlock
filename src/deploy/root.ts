/**
 * 服务器侧的两个运维 op：列目录、改落点。
 *
 * 为什么单独给 op：root 决定 releases/backups/current 在哪，也决定部署账号
 * 有权往哪写。所以只认绝对路径，并拒绝盘根与系统目录——改错一次就是往
 * Windows 里倒垃圾。写回用「临时文件 + 改名」，避免写一半留下坏配置。
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import type { DeployContext } from './context.ts';
import { DeployError } from './errors.ts';

export interface ServerDirEntry {
  readonly name: string;
  readonly path: string;
  readonly dir: boolean;
}

export interface ServerListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: ServerDirEntry[];
  readonly places: Array<{ name: string; path: string }>;
  readonly truncated: boolean;
}

const MAX_DIRS = 400;
const MAX_FILES = 40;

const WINDOWS_BLOCKED = ['windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin'];
const LINUX_BLOCKED = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/lib', '/var/lib', '/proc', '/sys', '/dev'];

/** 部署账号的家目录：ssh 会话里 USERPROFILE 就是真实 profile（可能带机器后缀）。 */
function homeDir(ctx: DeployContext): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home !== '') return home;
  return ctx.kind === 'windows' ? 'C:\\' : '/';
}

/** 默认从桌面开始：发版最常落在桌面，没有桌面就退回家目录。 */
export function defaultStartDir(ctx: DeployContext): string {
  const home = homeDir(ctx);
  const desktop = join(home, 'Desktop');
  return existsSync(desktop) ? desktop : home;
}

function placesFor(ctx: DeployContext): Array<{ name: string; path: string }> {
  const home = homeDir(ctx);
  const candidates: Array<[string, string]> = [
    ['桌面', join(home, 'Desktop')],
    ['用户目录', home],
  ];
  // 现有各应用的落点也放进来，改的时候一眼看到别的应用放在哪。
  for (const [id, app] of Object.entries(ctx.config.apps)) {
    candidates.push([`${id} 当前`, app.root]);
  }
  if (ctx.kind === 'windows') {
    for (const drive of ['C:', 'D:', 'E:', 'F:']) candidates.push([`${drive} 盘`, `${drive}\\`]);
  } else {
    candidates.push(['根目录', '/']);
  }
  return candidates.filter(([, path]) => existsSync(path)).map(([name, path]) => ({ name, path }));
}

export function listServerDirectory(ctx: DeployContext, target: unknown): ServerListing {
  const requested = typeof target === 'string' && target.trim() !== '' ? target.trim() : defaultStartDir(ctx);
  const dir = resolve(requested);
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new DeployError('INVALID_REQUEST', `目录不存在或不可读：${dir}`);
  }
  if (!stats.isDirectory()) throw new DeployError('INVALID_REQUEST', `不是目录：${dir}`);

  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new DeployError('INVALID_REQUEST', `没有权限读取：${dir}`);
  }

  const dirs: ServerDirEntry[] = [];
  const files: ServerDirEntry[] = [];
  for (const item of dirents) {
    if (item.name.startsWith('.')) continue;
    const full = join(dir, item.name);
    if (item.isDirectory() || item.isSymbolicLink()) dirs.push({ name: item.name, path: full, dir: true });
    else files.push({ name: item.name, path: full, dir: false });
  }
  const byName = (a: ServerDirEntry, b: ServerDirEntry): number => a.name.localeCompare(b.name);
  dirs.sort(byName);
  files.sort(byName);

  const entries = [...dirs.slice(0, MAX_DIRS), ...files.slice(0, MAX_FILES)];
  const isRoot = /^[A-Za-z]:[\\/]$/.test(dir) || dir === '/';
  return {
    path: dir,
    parent: isRoot ? null : dirname(dir),
    entries,
    places: placesFor(ctx),
    truncated: dirs.length > MAX_DIRS || files.length > MAX_FILES,
  };
}

/** 拒绝盘根与系统目录：这些地方写 releases/ 会毁掉系统。 */
function assertUsableRoot(ctx: DeployContext, target: string): void {
  if (ctx.kind === 'windows') {
    if (/^[A-Za-z]:[\\/]?$/.test(target)) throw new DeployError('INVALID_REQUEST', '不能把盘根当发布目录');
    const lower = target.toLowerCase().replace(/[\\/]+$/, '');
    for (const bad of WINDOWS_BLOCKED) {
      if (lower === `c:\\${bad}` || lower.startsWith(`c:\\${bad}\\`)) {
        throw new DeployError('INVALID_REQUEST', `不能发布到系统目录：${target}`);
      }
    }
    return;
  }
  const trimmed = target.replace(/\/+$/, '') || '/';
  if (trimmed === '/') throw new DeployError('INVALID_REQUEST', '不能把根目录当发布目录');
  for (const bad of LINUX_BLOCKED) {
    if (trimmed === bad || trimmed.startsWith(`${bad}/`)) {
      throw new DeployError('INVALID_REQUEST', `不能发布到系统目录：${target}`);
    }
  }
}

export interface RootUpdate {
  readonly app: string;
  readonly previous: string;
  readonly root: string;
  readonly note: string;
}

/**
 * 改某个应用的落点，写回服务器配置。
 *
 * 只改 root，不动启停命令与健康检查——换目录不等于换应用。
 * 旧目录里的版本不搬：迁移语义要显式，不然一次改路径就悄悄挪走线上文件。
 */
export function updateRoot(ctx: DeployContext, appId: unknown, root: unknown): RootUpdate {
  if (typeof appId !== 'string' || appId === '') throw new DeployError('INVALID_REQUEST', '需要指定 app');
  const app = ctx.config.apps[appId];
  if (app === undefined) throw new DeployError('APP_NOT_FOUND', `未配置的应用：${appId}`);
  if (typeof root !== 'string' || root.trim() === '') throw new DeployError('INVALID_REQUEST', '需要目标目录');

  const configPath = ctx.configPath;
  if (configPath === undefined) throw new DeployError('INVALID_REQUEST', '部署器没有拿到配置路径，无法改落点');

  const wanted = root.trim();
  // 先看原始输入是不是绝对路径：resolve() 会把相对路径按 cwd 补全，事后就查不出来了。
  if (!isAbsolute(wanted)) throw new DeployError('INVALID_REQUEST', `必须是绝对路径：${wanted}`);
  const target = resolve(wanted);
  const previous = app.root;
  if (resolve(previous) === target) {
    return { app: appId, previous, root: target, note: '落点没有变化' };
  }
  assertUsableRoot(ctx, target);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new DeployError('INTERNAL', `配置文件不可读：${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || !('apps' in raw)) {
    throw new DeployError('INTERNAL', '配置文件结构不对，缺少 apps');
  }
  const apps = (raw as { apps: Record<string, unknown> }).apps;
  const entry = apps[appId];
  if (entry === null || typeof entry !== 'object') {
    throw new DeployError('INTERNAL', `配置文件里没有应用 ${appId}`);
  }

  (entry as { root: string }).root = target;
  const tmp = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    renameSync(tmp, configPath);
  } catch (error) {
    throw new DeployError('INTERNAL', `写回配置失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    app: appId,
    previous,
    root: target,
    note: '已写回服务器配置，下一次请求起生效；旧目录里的版本不会自动搬过来，需要重新发一版',
  };
}
