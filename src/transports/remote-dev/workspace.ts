/**
 * 开发工作区文件操作。安全判定全部收口在这里：路径穿越、符号链接逃逸、超大文件、并发覆盖
 * 一旦分散到各 op，随便新增一个 op 就会漏。
 *
 * 三个不变量：
 * 1. 相对路径先过语法白名单（绝对路径 / `..` / NUL 拒绝），再 resolve + 带分隔符的前缀比较，
 *    最后对**落点**做 realpath 校验——前两步挡不住「根内一个指向根外的符号链接」。
 * 2. 写入用同目录临时文件 + rename：直接 write 中途崩溃会留下半截源码，比不写更难查。
 * 3. 写后回读 hash：rename 成功不等于内容落盘正确（配额、杀毒改写、网络盘语义）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { devApplyResultSchema } from '../../contracts/remote.ts';
import type { DevApplyResult, DevFileEntry, DevRead } from '../../contracts/remote.ts';
import { RemoteDevError } from './protocol.ts';

/** 单文件默认上限 256KB；配置只能调小——再大就不适合走逐行 JSON 协议。 */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_DEPTH = 4;
export interface ListOptions { readonly maxEntries?: number; readonly maxDepth?: number }
export interface ListResult { readonly entries: readonly DevFileEntry[]; readonly truncated: boolean }
export interface ApplyEdit { readonly oldText: string; readonly newText: string; readonly occurrence?: number }
export interface ApplyRequest {
  readonly content?: string;
  readonly edits?: readonly ApplyEdit[];
  /** null 表示「新建」：目标已存在即冲突。 */
  readonly expectedHash: string | null;
  readonly operationId: string;
}
export interface OperationLedger {
  get(path: string, operationId: string): Promise<DevApplyResult | null>;
  set(result: DevApplyResult): Promise<void>;
}
export interface ApplyOptions { readonly maxFileBytes?: number; readonly ledger?: OperationLedger }

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function compareKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** 前缀比较必须带分隔符：`C:\srv\ws-evil` 不是 `C:\srv\ws` 的子路径。 */
function isInside(parent: string, child: string): boolean {
  const a = compareKey(parent);
  const b = compareKey(child);
  return b === a || b.startsWith(`${a}${sep}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 语法白名单：返回规范化相对路径（正斜杠、无空段、无 `.`）。 */
function normalizeRelative(relPath: string): string {
  if (typeof relPath !== 'string') throw new RemoteDevError('INVALID_REQUEST', 'path 必须是字符串');
  if (relPath === '' || relPath === '.') return '';
  if (relPath.length > 400) throw new RemoteDevError('INVALID_REQUEST', 'path 超过 400 字符');
  if (relPath.includes('\u0000')) throw new RemoteDevError('PATH_OUT_OF_SCOPE', 'path 含 NUL 字节');
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new RemoteDevError('PATH_OUT_OF_SCOPE', '拒绝绝对路径：只接受工作区相对路径');
  }
  const parts = relPath.split(/[\\/]+/).filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..')) throw new RemoteDevError('PATH_OUT_OF_SCOPE', '拒绝 .. 段：可能越出工作区');
  return parts.join('/');
}

interface Target { readonly realRoot: string; readonly abs: string; readonly exists: boolean }

/** 解析落点：逐段走到最近的已存在祖先再 realpath，这样「新建文件」也能校验而不必先建目录。 */
async function resolveTarget(root: string, relPath: string): Promise<Target> {
  const clean = normalizeRelative(relPath);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new RemoteDevError('INTERNAL', `工作区根目录不可用：${root}`);
  }
  const abs = resolve(realRoot, clean === '' ? '.' : clean);
  if (!isInside(realRoot, abs)) throw new RemoteDevError('PATH_OUT_OF_SCOPE', '路径越出工作区');
  let cursor = abs;
  let missing = 0;
  for (;;) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'ENOENT') throw new RemoteDevError('INTERNAL', `无法读取路径：${clean}`);
      if (compareKey(cursor) === compareKey(realRoot)) break;
      const parent = dirname(cursor);
      if (compareKey(parent) === compareKey(cursor)) throw new RemoteDevError('PATH_OUT_OF_SCOPE', '路径越出工作区');
      missing += 1;
      cursor = parent;
    }
  }
  if (!isInside(realRoot, await realpath(cursor))) throw new RemoteDevError('PATH_OUT_OF_SCOPE', '路径经符号链接指向工作区外');
  if (missing === 0 && !isInside(realRoot, await realpath(abs))) throw new RemoteDevError('PATH_OUT_OF_SCOPE', '目标经符号链接指向工作区外');
  return { realRoot, abs, exists: missing === 0 };
}

async function ensureParent(realRoot: string, abs: string): Promise<void> {
  const parent = dirname(abs);
  if (compareKey(parent) === compareKey(realRoot)) return;
  await mkdir(parent, { recursive: true });
  if (!isInside(realRoot, await realpath(parent))) throw new RemoteDevError('PATH_OUT_OF_SCOPE', '新建目录时越出工作区');
}

/** 同目录临时文件 + rename。导出给 jobs 复用，避免两份「原子写」实现各自漏掉清理。 */
export async function writeFileAtomic(abs: string, data: Buffer | string): Promise<void> {
  const temp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data, { flag: 'wx' });
    await rename(temp, abs);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw new RemoteDevError('INTERNAL', `写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 目录列表。符号链接只列出不跟进：跟进去就绕过前缀校验，等于把根外目录暴露出来。 */
export async function list(root: string, options: ListOptions = {}): Promise<ListResult> {
  const maxEntries = clamp(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, 2000);
  const maxDepth = clamp(options.maxDepth ?? DEFAULT_MAX_DEPTH, 0, 12);
  const target = await resolveTarget(root, '');
  const entries: DevFileEntry[] = [];
  let truncated = false;
  const walk = async (dirAbs: string, prefix: string, depth: number): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return; // 单个目录不可读不该让整次列表失败
    }
    for (const name of dirents.map(dirent => dirent.name).sort((a, b) => a.localeCompare(b))) {
      if (entries.length >= maxEntries) { truncated = true; return; }
      const childRel = prefix === '' ? name : `${prefix}/${name}`;
      let info: Stats;
      try { info = await lstat(join(dirAbs, name)); } catch { continue; }
      const kind: DevFileEntry['kind'] = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'dir' : 'file';
      entries.push({ path: childRel, kind, size: kind === 'file' ? info.size : 0, hash: null });
      if (kind === 'dir' && depth < maxDepth) await walk(join(dirAbs, name), childRel, depth + 1);
    }
  };
  await walk(target.realRoot, '', 0);
  return { entries, truncated };
}

/** 读取文本文件。超限直接 TOO_LARGE：截断后假装成功，后续写入会用半截内容覆盖原文。 */
export async function read(root: string, relPath: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<DevRead> {
  const clean = normalizeRelative(relPath);
  if (clean === '') throw new RemoteDevError('INVALID_REQUEST', 'read 需要一个文件路径');
  const target = await resolveTarget(root, clean);
  if (!target.exists) throw new RemoteDevError('INVALID_REQUEST', `文件不存在：${clean}`);
  const info = await stat(target.abs);
  if (!info.isFile()) throw new RemoteDevError('INVALID_REQUEST', `目标不是普通文件：${clean}`);
  const limit = clamp(maxBytes, 1, DEFAULT_MAX_FILE_BYTES);
  if (info.size > limit) throw new RemoteDevError('TOO_LARGE', `文件 ${info.size} 字节超过上限 ${limit}`, { size: info.size, limit });
  const buffer = await readFile(target.abs);
  if (buffer.includes(0)) throw new RemoteDevError('INVALID_REQUEST', '不支持二进制文件（含 NUL 字节）');
  return { path: clean, hash: sha256(buffer), content: buffer.toString('utf8'), truncated: false };
}

function applyEdits(source: string, edits: readonly ApplyEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) throw new RemoteDevError('INVALID_REQUEST', 'edits 不能为空');
  let text = source;
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (edit === null || typeof edit !== 'object' || typeof edit.oldText !== 'string' || edit.oldText === '' || typeof edit.newText !== 'string') {
      throw new RemoteDevError('INVALID_REQUEST', `edits[${index}] 必须是 {oldText,newText}`);
    }
    const positions: number[] = [];
    for (let at = text.indexOf(edit.oldText); at >= 0; at = text.indexOf(edit.oldText, at + 1)) positions.push(at);
    const occurrence = edit.occurrence;
    if (occurrence === undefined) {
      if (positions.length !== 1) throw new RemoteDevError('HASH_MISMATCH', `edits[${index}] 命中 ${positions.length} 处，要求唯一`);
    } else if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > positions.length) {
      throw new RemoteDevError('HASH_MISMATCH', `edits[${index}] 第 ${String(occurrence)} 处不存在（共 ${positions.length} 处）`);
    }
    const at = occurrence === undefined ? positions[0] : positions[occurrence - 1];
    text = `${text.slice(0, at)}${edit.newText}${text.slice(at + edit.oldText.length)}`;
  }
  return text;
}

/**
 * 写入。`expectedHash` 是乐观并发控制：别人先改过就 HASH_MISMATCH，而不是把对方修改覆盖掉。
 * `operationId` 幂等：重试同一次操作不会产生第二次写入。
 */
export async function apply(root: string, relPath: string, request: ApplyRequest, options: ApplyOptions = {}): Promise<DevApplyResult> {
  const clean = normalizeRelative(relPath);
  if (clean === '') throw new RemoteDevError('INVALID_REQUEST', 'apply 需要一个文件路径');
  if (typeof request.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(request.operationId)) {
    throw new RemoteDevError('INVALID_REQUEST', 'operationId 必须是 8..64 位 [A-Za-z0-9_-]');
  }
  const ledger = options.ledger;
  if (ledger !== undefined) {
    const prior = await ledger.get(clean, request.operationId);
    if (prior !== null) return { ...prior, changed: false };
  }
  const hasContent = typeof request.content === 'string';
  const edits = Array.isArray(request.edits) ? request.edits : undefined;
  if (hasContent === (edits !== undefined)) throw new RemoteDevError('INVALID_REQUEST', 'content 与 edits 必须二选一');
  const limit = clamp(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, DEFAULT_MAX_FILE_BYTES);
  const target = await resolveTarget(root, clean);
  if (target.exists) {
    const info = await stat(target.abs);
    if (!info.isFile()) throw new RemoteDevError('INVALID_REQUEST', `目标不是普通文件：${clean}`);
    if (info.size > limit) throw new RemoteDevError('TOO_LARGE', `现有文件 ${info.size} 字节超过上限 ${limit}`, { size: info.size, limit });
  }
  const before = target.exists ? await readFile(target.abs) : null;
  const hashBefore = before === null ? null : sha256(before);
  if (request.expectedHash === null) {
    if (hashBefore !== null) throw new RemoteDevError('HASH_MISMATCH', '期望新建，但目标已存在', { path: clean });
  } else if (hashBefore === null) {
    throw new RemoteDevError('HASH_MISMATCH', '目标不存在，无法按 expectedHash 修改', { path: clean });
  } else if (hashBefore !== request.expectedHash) {
    throw new RemoteDevError('HASH_MISMATCH', 'expectedHash 与当前内容不一致', { path: clean, current: hashBefore });
  }
  const nextBuffer = Buffer.from(hasContent ? request.content ?? '' : applyEdits(before === null ? '' : before.toString('utf8'), edits ?? []), 'utf8');
  if (nextBuffer.length > limit) throw new RemoteDevError('TOO_LARGE', `写入后 ${nextBuffer.length} 字节超过上限 ${limit}`, { size: nextBuffer.length, limit });
  const hashAfter = sha256(nextBuffer);
  const finish = async (changed: boolean): Promise<DevApplyResult> => {
    const result: DevApplyResult = { path: clean, hashBefore, hashAfter, changed, operationId: request.operationId };
    if (ledger !== undefined) await ledger.set(result);
    return result;
  };
  if (hashBefore === hashAfter) return finish(false);
  await ensureParent(target.realRoot, target.abs);
  await writeFileAtomic(target.abs, nextBuffer);
  if (sha256(await readFile(target.abs)) !== hashAfter) throw new RemoteDevError('INTERNAL', '写入后回读校验失败', { path: clean });
  return finish(true);
}

/**
 * 工作区内容摘要：文件按相对路径排序后逐个喂 `path\0内容hash\n`。
 * 排序是哈希稳定的前提：目录遍历顺序随文件系统变化，不排序同一份内容会算出两个哈希。
 */
export async function contentDigest(root: string, options: { maxEntries?: number; maxFileBytes?: number } = {}): Promise<{ digest: string; files: number }> {
  const listed = await list(root, { maxEntries: options.maxEntries ?? 2000, maxDepth: 12 });
  if (listed.truncated) throw new RemoteDevError('TOO_LARGE', '工作区文件数超过冻结上限，拒绝生成不可信摘要');
  const limit = clamp(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, DEFAULT_MAX_FILE_BYTES);
  const paths = listed.entries.filter(entry => entry.kind === 'file').map(entry => entry.path).sort();
  const hash = createHash('sha256');
  for (const relPath of paths) {
    const buffer = await readFile(join(root, relPath));
    if (buffer.length > limit) throw new RemoteDevError('TOO_LARGE', `文件 ${relPath} 超过摘要上限 ${limit}`);
    hash.update(`${relPath}\u0000${sha256(buffer)}\n`);
  }
  return { digest: hash.digest('hex'), files: paths.length };
}
/** 幂等记录落在 stateDir（工作区外）：重启后同 operationId 仍命中，不会重复写文件。 */
export function createOperationLedger(stateDir: string): OperationLedger {
  const file = join(stateDir, 'apply-operations.json');
  const entries = new Map<string, DevApplyResult>();
  let loaded = false;
  const keyOf = (path: string, operationId: string): string => `${path}\u0000${operationId}`;
  const load = async (): Promise<void> => {
    if (loaded) return;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') { loaded = true; return; }
      throw new RemoteDevError('INTERNAL', '操作记录不可读');
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('不是数组');
      for (const item of parsed) {
        const one = devApplyResultSchema.safeParse(item);
        if (!one.success) throw new Error('记录损坏');
        entries.set(keyOf(one.data.path, one.data.operationId), one.data);
      }
    } catch {
      // 坏记录不能当空表：否则同一 operationId 会再写一次，幂等承诺失效。
      throw new RemoteDevError('INTERNAL', '操作记录文件损坏，拒绝在未知状态下继续', { file });
    }
    // 只有解析成功才记「已加载」：坏文件要每次调用都继续报 INTERNAL，不能第二次静默放行。
    loaded = true;
  };
  return {
    async get(path, operationId) {
      await load();
      return entries.get(keyOf(path, operationId)) ?? null;
    },
    async set(result) {
      await load();
      entries.set(keyOf(result.path, result.operationId), result);
      await mkdir(stateDir, { recursive: true });
      await writeFileAtomic(file, Buffer.from(JSON.stringify([...entries.values()].slice(-500)), 'utf8'));
    },
  };
}
