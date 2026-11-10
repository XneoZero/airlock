/**
 * 数据备份与恢复：发布前把 `backupPaths` 指到的目录打成 tar.gz，回滚时按需解回去。
 *
 * 为什么默认只回代码：数据恢复比代码回退危险得多——覆盖的是正在使用的真实数据，
 * 而且旧备份可能和当前 schema 不兼容。所以恢复必须由配置或请求显式开启。
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { create, extract } from 'tar';
import type { AppConfig } from './contracts.ts';
import { DeployError, messageOf } from './errors.ts';
import { backupFile, ensureAppDirs } from './state.ts';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** 备份路径必须落在应用根内，且不允许 `..` 跳出——否则等于给了一个任意打包能力。 */
function safeRelative(root: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new DeployError('INVALID_REQUEST', `备份路径必须是相对应用根的路径：${path}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new DeployError('INVALID_REQUEST', `备份路径不允许上跳：${path}`);
  }
  return normalized;
}

export interface BackupOutcome {
  readonly path: string | null;
  readonly paths: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * 打包发布前快照。文件按 `backups/<version>-pre.tar.gz` 命名，
 * 语义是「激活该版本之前的数据长什么样」，回滚到该版本时用它还原。
 * 已存在则直接复用（重试同一次发布不重复备份，也不会覆盖更早的快照）。
 */
export async function createBackup(root: string, version: string, paths: readonly string[]): Promise<BackupOutcome> {
  if (paths.length === 0) return { path: null, paths: [], skipped: [] };
  await ensureAppDirs(root);
  const target = backupFile(root, version);
  if (await exists(target)) return { path: target, paths: [], skipped: paths };

  const usable: string[] = [];
  const skipped: string[] = [];
  for (const raw of paths) {
    const rel = safeRelative(root, raw);
    if (await exists(join(root, rel))) usable.push(rel);
    else skipped.push(rel);
  }
  if (usable.length === 0) return { path: null, paths: [], skipped };

  try {
    await create({ file: target, cwd: root, gzip: true, portable: true, mtime: new Date(0) }, usable);
  } catch (error) {
    throw new DeployError('INTERNAL', `备份失败：${messageOf(error)}`);
  }
  return { path: target, paths: usable, skipped };
}

/** 恢复快照：解到应用根，覆盖同名路径。调用方负责先停服务。 */
export async function restoreBackup(root: string, version: string, app: AppConfig): Promise<string> {
  const target = backupFile(root, version);
  if (!(await exists(target))) {
    throw new DeployError('VERSION_NOT_FOUND', `版本 ${version} 没有可用备份，不能恢复数据`);
  }
  if (app.backupPaths === undefined || app.backupPaths.length === 0) {
    throw new DeployError('INVALID_REQUEST', '该应用没有配置 backupPaths，拒绝执行数据恢复');
  }
  try {
    await extract({ file: target, cwd: root, gzip: true, preservePaths: false });
  } catch (error) {
    throw new DeployError('INTERNAL', `恢复备份失败：${messageOf(error)}`);
  }
  return target;
}

export function hasBackup(root: string, version: string): Promise<boolean> {
  return exists(backupFile(root, version));
}
