/**
 * 本机编排：读档案 → 打包 → install → activate。
 *
 * 这里刻意不跑构建命令：构建是用户自己的事（npm run build / gradle / dotnet publish），
 * 本工具只负责「把已经构建好的目录推上去」。这样它不绑定任何技术栈。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deployProfileTableSchema, type DeployProfile } from './contracts.ts';
import { packProject, type TreeManifest } from './archive.ts';
import { DeployError } from './errors.ts';

const PROFILE_ENV = 'AIRLOCK_DEPLOY_PROFILES';
const PROFILE_FILE = 'config/deploy-profiles.json';
const execFileAsync = promisify(execFile);

export interface LoadedProfile {
  readonly name: string;
  readonly profile: DeployProfile;
  /** 档案文件所在目录，用于解析 workspace 的相对路径。 */
  readonly baseDir: string;
}

export function loadProfile(name?: string): LoadedProfile {
  const inline = process.env[PROFILE_ENV];
  let raw: unknown;
  let baseDir = process.cwd();
  let source = PROFILE_FILE;
  if (inline !== undefined && inline.trim() !== '') {
    try {
      raw = JSON.parse(inline);
    } catch {
      throw new DeployError('INVALID_REQUEST', `${PROFILE_ENV} 不是合法 JSON`);
    }
    source = PROFILE_ENV;
  } else {
    const path = resolve(PROFILE_FILE);
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
      baseDir = dirname(path);
    } catch {
      throw new DeployError('INVALID_REQUEST', `没有可用的档案：${PROFILE_FILE} 不存在或不是 JSON。先配好 config/deploy-profiles.json，或设置 ${PROFILE_ENV}`);
    }
  }
  const parsed = deployProfileTableSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DeployError('INVALID_REQUEST', `档案不符合契约（${source}）：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  const table = parsed.data;
  const chosen = name ?? table.default;
  if (chosen === undefined || chosen === '') {
    const names = Object.keys(table.profiles).join(', ') || '（空）';
    throw new DeployError('INVALID_REQUEST', `没有指定档案，且档案表没有 default。已配置：${names}`);
  }
  const profile = table.profiles[chosen];
  if (profile === undefined) {
    const names = Object.keys(table.profiles).join(', ') || '（空）';
    throw new DeployError('INVALID_REQUEST', `找不到档案：${chosen}。已配置：${names}`);
  }
  return { name: chosen, profile, baseDir };
}

/** 版本号：时间戳 + git 短哈希。同秒重复时由服务器 VERSION_EXISTS 拦住，不自动加后缀。 */
export async function makeVersion(sourceDir: string, commit: string | null): Promise<string> {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return commit === null ? stamp : `${stamp}-${commit.slice(0, 7)}`;
}

/** git 只用来读提交号做标记；不是仓库就返回 null，不阻止发布。 */
export async function gitCommitOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { windowsHide: true });
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export interface PackedRelease {
  readonly version: string;
  readonly archive: string;
  readonly manifest: TreeManifest;
  readonly bytes: number;
  readonly commit: string | null;
  cleanup(): Promise<void>;
}

export interface PackOptions {
  readonly sourceDir: string;
  readonly version?: string;
  readonly commit?: string | null;
  readonly exclude?: readonly string[];
}

export async function packRelease(options: PackOptions): Promise<PackedRelease> {
  const sourceDir = resolve(options.sourceDir);
  const commit = options.commit ?? await gitCommitOf(sourceDir);
  const version = options.version ?? await makeVersion(sourceDir, commit);
  const workDir = await mkdtemp(join(tmpdir(), 'airlock-release-'));
  const archive = join(workDir, 'release.tar.gz');
  const manifest = await packProject({ sourceDir, outFile: archive, exclude: options.exclude ?? [] });
  const info = await stat(archive);
  return {
    version, archive, manifest, bytes: info.size, commit,
    async cleanup() {
      const { rm } = await import('node:fs/promises');
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function readProfileFile(path: string): Promise<DeployProfile> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const parsed = deployProfileTableSchema.safeParse(raw);
  if (!parsed.success) throw new DeployError('INVALID_REQUEST', `档案不符合契约：${path}`);
  const first = Object.values(parsed.data.profiles)[0];
  if (first === undefined) throw new DeployError('INVALID_REQUEST', `档案表为空：${path}`);
  return first;
}
