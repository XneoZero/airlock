/**
 * mirror 布局：服务器上的目录就是源目录的副本，不多出 releases/、current、state.json。
 *
 * 版本由 git 管：要回退就 `git checkout` 到旧提交再发一版，服务器不保留历史。
 * 代价是这里没有原子切换——同步到一半失败会留下半新半旧，所以过程尽量做成
 * 「先写新文件（逐个原子替换），最后删多余」，这样至少不会出现「文件先没了」。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 把 `a/b` 归一化成斜杠形式，便于比较前缀。 */
function normalize(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** 这个相对路径是否落在某个受保护目录里（含它本身）。 */
function isProtected(rel: string, protectedPaths: readonly string[]): boolean {
  for (const raw of protectedPaths) {
    const guard = normalize(raw);
    if (guard === '') continue;
    if (rel === guard || rel.startsWith(`${guard}/`)) return true;
  }
  return false;
}

/** 这个目录是不是某个受保护路径的祖先（需要递归进去，不能整个删）。 */
function hasProtectedDescendant(rel: string, protectedPaths: readonly string[]): boolean {
  for (const raw of protectedPaths) {
    const guard = normalize(raw);
    if (guard === '' || guard === rel) continue;
    if (guard.startsWith(`${rel}/`)) return true;
  }
  return false;
}

function walkFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

export interface MirrorResult {
  readonly written: number;
  readonly removed: number;
}

/**
 * 把 `sourceDir` 的内容镜像到 `targetDir`：
 * 1. 先按源清单逐个文件原子覆盖（写 `<name>.airlock-tmp` 再 rename）；
 * 2. 再删掉目标里源没有的条目；
 * 3. `protectedPaths`（sharedPaths，通常是数据目录）整棵跳过，不覆盖也不删。
 */
export function syncMirror(sourceDir: string, targetDir: string, protectedPaths: readonly string[] = []): MirrorResult {
  mkdirSync(targetDir, { recursive: true });
  let written = 0;

  for (const rel of walkFiles(sourceDir)) {
    if (isProtected(rel, protectedPaths)) continue;
    const from = join(sourceDir, ...rel.split('/'));
    const to = join(targetDir, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    const temp = `${to}.airlock-tmp`;
    copyFileSync(from, temp);
    renameSync(temp, to);
    written += 1;
  }

  let removed = 0;
  const prune = (relDir: string): void => {
    const abs = relDir === '' ? targetDir : join(targetDir, ...relDir.split('/'));
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (rel.endsWith('.airlock-tmp')) {
        rmSync(join(abs, entry.name), { force: true });
        continue;
      }
      if (isProtected(rel, protectedPaths)) continue;
      if (entry.isDirectory()) {
        if (hasProtectedDescendant(rel, protectedPaths) || existsSync(join(sourceDir, ...rel.split('/')))) {
          prune(rel);
          continue;
        }
        rmSync(join(targetDir, ...rel.split('/')), { recursive: true, force: true });
        removed += 1;
        continue;
      }
      if (!existsSync(join(sourceDir, ...rel.split('/')))) {
        rmSync(join(targetDir, ...rel.split('/')), { force: true });
        removed += 1;
      }
    }
  };
  prune('');

  return { written, removed };
}

/** mirror 布局下，落点必须是个普通目录（不能还是指向版本的链接）。 */
export function isPlainDirectory(target: string): boolean {
  try {
    const info = statSync(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}
