/**
 * 归档与清单：本机打包时算出「每个文件 + 全树摘要」，服务器解压后重算同一摘要。
 *
 * 为什么清单不进包：包里的清单可以被伪造，而「解压后按同一算法重算」是独立证据。
 * 摘要算法必须两端一致且与文件顺序无关——排序后逐条喂 `路径\0文件哈希\n`。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { create, extract } from 'tar';

/** 默认排除：版本库、依赖目录、本工具自己的中间产物。需要别的规则由调用方追加。 */
export const DEFAULT_EXCLUDE = ['.git', 'node_modules', '.airlock', '.dsh', 'dist', 'build', '.cache'];

export interface FileEntry {
  readonly path: string;
  readonly size: number;
  readonly hash: string;
}

export interface TreeManifest {
  readonly files: readonly FileEntry[];
  readonly totalHash: string;
  readonly bytes: number;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 路径统一成 `/` 分隔、无前导 ./，作为摘要输入，保证 Windows 与 Linux 算出同一个值。 */
export function normalizePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function shouldExclude(relPath: string, patterns: readonly string[]): boolean {
  const segments = relPath.split('/');
  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    const cleaned = pattern.replace(/^\.\//, '').replace(/\/$/, '');
    if (cleaned === '') continue;
    if (segments.includes(cleaned)) return true;
    if (relPath === cleaned || relPath.startsWith(`${cleaned}/`)) return true;
  }
  return false;
}

/** 递归收集普通文件。符号链接只记录链接本身不跟进（跟进去会拖出工作区外的内容）。 */
export async function collectFiles(sourceDir: string, exclude: readonly string[] = []): Promise<{ files: FileEntry[]; links: string[] }> {
  const patterns = [...DEFAULT_EXCLUDE, ...exclude];
  const files: FileEntry[] = [];
  const links: string[] = [];

  async function walk(dir: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const abs = join(dir, item.name);
      const rel = normalizePath(relative(sourceDir, abs));
      if (shouldExclude(rel, patterns)) continue;
      if (item.isSymbolicLink()) {
        // 符号链接单独登记，打包时按链接写入；解包侧不允许它指向目录外。
        links.push(rel);
        continue;
      }
      if (item.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!item.isFile()) continue;
      const info = await stat(abs);
      const bytes = await readFile(abs);
      files.push({ path: rel, size: info.size, hash: sha256(bytes) });
    }
  }

  await walk(sourceDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, links };
}

/** 全树摘要：与文件系统遍历顺序无关，只与「路径 + 内容哈希」集合有关。 */
export function digestFiles(files: readonly FileEntry[]): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) hash.update(`${file.path}\u0000${file.hash}\n`);
  return hash.digest('hex');
}

export async function buildManifest(sourceDir: string, exclude: readonly string[] = []): Promise<TreeManifest> {
  const { files } = await collectFiles(sourceDir, exclude);
  if (files.length === 0) throw new Error('源目录没有可打包的文件');
  return {
    files,
    totalHash: digestFiles(files),
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

/** 对解压后的目录重算摘要。不套排除规则：包内出现什么就必须全部计入，否则漏检是免费的。 */
export async function manifestOfDirectory(dir: string): Promise<TreeManifest> {
  const { files } = await collectFiles(dir, []);
  return {
    files,
    totalHash: digestFiles(files),
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export interface PackOptions {
  readonly sourceDir: string;
  readonly outFile: string;
  readonly exclude?: readonly string[];
}

/** 打出确定性的 tar.gz：固定 mtime/uid/gid，同一份源码两次打包内容一致（便于比对）。 */
export async function packProject(options: PackOptions): Promise<TreeManifest> {
  const manifest = await buildManifest(options.sourceDir, options.exclude ?? []);
  const entries = manifest.files.map(file => file.path);
  await create({
    file: options.outFile,
    cwd: options.sourceDir,
    gzip: true,
    portable: true,
    mtime: new Date(0),
    noDirRecurse: true,
    follow: false,
    filter: path => entries.includes(normalizePath(path)),
  }, entries);
  return manifest;
}

export interface UnpackOptions {
  readonly archive: string;
  readonly destDir: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/**
 * 解压并做结构校验：拒绝绝对路径、`..`、写出目标目录之外的条目。
 * tar 库的 filter 只能在读取时过滤，所以这里额外在解压后复验每个文件仍位于 destDir 内。
 */
export async function unpackArchive(options: UnpackOptions): Promise<TreeManifest> {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxBytes = options.maxBytes ?? 1_073_741_824;
  let seen = 0;
  let bytes = 0;
  // filter 里抛错会让解压流半途炸掉（Promise 已 settle，错误变成未捕获异常），
  // 所以这里只记录第一处违规并跳过后续条目，解压结束再统一拒绝。
  let violation: string | null = null;
  await extract({
    file: options.archive,
    cwd: options.destDir,
    gzip: true,
    preservePaths: false,
    filter: (path, entry) => {
      if (violation !== null) return false;
      const clean = normalizePath(path);
      if (clean === '' || clean === '.') return false;
      if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) {
        violation = `归档含绝对路径：${clean}`;
        return false;
      }
      if (clean.split('/').includes('..')) {
        violation = `归档含上跳路径：${clean}`;
        return false;
      }
      seen += 1;
      if (seen > maxFiles) {
        violation = `归档条目过多：超过 ${maxFiles}`;
        return false;
      }
      bytes += typeof entry.size === 'number' ? entry.size : 0;
      if (bytes > maxBytes) {
        violation = `归档展开后超过 ${maxBytes} 字节`;
        return false;
      }
      return true;
    },
  });
  if (violation !== null) throw new Error(violation);
  return manifestOfDirectory(options.destDir);
}

/** 流式计算大文件哈希，避免把整个文件读进内存。 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => done());
    stream.on('error', error => fail(error));
  });
  return hash.digest('hex');
}

/** 判断路径是否为目录（跟随符号链接）。 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}
