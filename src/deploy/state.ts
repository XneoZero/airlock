/**
 * 服务器侧状态：current 指针 + 版本历史，落在 `<root>/state.json`。
 *
 * 三条纪律：
 * 1. current 以「链接的真实目标」为准，不以 state.json 为准——状态文件被改坏时，
 *    磁盘上实际在跑哪个版本仍然可读，两者不一致要在 status 里如实暴露。
 * 2. 每次写状态都原子替换（写 .tmp 再 rename），发布中途被杀不会留下半截 JSON。
 * 3. 历史只追加，删除旧版本不删记录，方便事后回答「上一版到底是谁发布失败」。
 */
import { mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appStateSchema, STATE_VERSION, type AppState, type ReleaseRecord } from './contracts.ts';

export const FILE_STATE = 'state.json';
export const FILE_LOG = 'deploy.log';
export const DIR_RELEASES = 'releases';
export const DIR_BACKUPS = 'backups';
export const DIR_INCOMING = 'incoming';
export const LINK_CURRENT = 'current';

export function releasesDir(root: string): string { return join(root, DIR_RELEASES); }
export function releaseDir(root: string, version: string): string { return join(root, DIR_RELEASES, version); }
export function backupsDir(root: string): string { return join(root, DIR_BACKUPS); }
export function backupFile(root: string, version: string): string { return join(root, DIR_BACKUPS, `${version}.tar.gz`); }
export function incomingDir(root: string): string { return join(root, DIR_INCOMING); }
export function statePath(root: string): string { return join(root, FILE_STATE); }
export function currentLink(root: string): string { return join(root, LINK_CURRENT); }

export async function ensureAppDirs(root: string): Promise<void> {
  for (const dir of [root, releasesDir(root), backupsDir(root), incomingDir(root)]) {
    await mkdir(dir, { recursive: true });
  }
}

const EMPTY_STATE: AppState = { current: null, history: [] };

export async function readState(root: string): Promise<AppState> {
  try {
    const raw = JSON.parse(await readFile(statePath(root), 'utf8')) as { v?: unknown } & Record<string, unknown>;
    if (raw.v !== STATE_VERSION) return { ...EMPTY_STATE };
    // 状态文件自己的版本号不参与应用状态契约校验，先剥掉再 parse。
    const { v: _version, ...rest } = raw;
    const parsed = appStateSchema.safeParse(rest);
    return parsed.success ? parsed.data : { ...EMPTY_STATE };
  } catch {
    // 文件不存在或损坏都返回空状态：调用方会结合磁盘上的 current 链接判断真相。
    return { ...EMPTY_STATE };
  }
}

export async function writeState(root: string, state: AppState): Promise<void> {
  await ensureAppDirs(root);
  const target = statePath(root);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify({ v: STATE_VERSION, ...state }, null, 2), 'utf8');
  await rename(temp, target);
}

/** 读 current 链接指向的版本目录名；链接不存在返回 null。 */
export async function currentVersionOnDisk(root: string): Promise<string | null> {
  try {
    const target = await readlink(currentLink(root));
    const parts = target.split(/[\\/]+/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

export function findRecord(state: AppState, version: string): ReleaseRecord | null {
  return state.history.find(record => record.version === version) ?? null;
}

/** 上一个已部署过的版本（跳过当前版本），用于默认回滚目标。 */
export function previousDeployed(state: AppState, current: string | null): ReleaseRecord | null {
  const deployed = state.history.filter(record => record.status === 'deployed' && record.version !== current);
  return deployed.at(-1) ?? null;
}

/** 追加一条记录：同版本已存在就整条替换（重装同版本时不重复堆历史）。 */
export function upsertRecord(state: AppState, record: ReleaseRecord): AppState {
  const history = state.history.filter(item => item.version !== record.version);
  history.push(record);
  history.sort((a, b) => a.createdAt - b.createdAt);
  return { current: state.current, history: history.slice(-200) };
}

export function setCurrent(state: AppState, current: string | null): AppState {
  return { current, history: state.history };
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** 追加一行发布日志。失败不抛：日志写不进去不该让发布失败。 */
export async function appendLog(root: string, line: string): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
    const stamp = new Date().toISOString();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(root, FILE_LOG), `[${stamp}] ${line}\n`, 'utf8');
  } catch {
    /* 忽略 */
  }
}

/** 读日志尾部若干行，供 logs op 返回。 */
export async function tailLog(root: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(join(root, FILE_LOG), 'utf8');
    return text.trimEnd().split(/\r?\n/).slice(-Math.max(1, lines));
  } catch {
    return [];
  }
}
