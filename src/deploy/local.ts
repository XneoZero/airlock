/**
 * 本机编排：读档案 → 打包 → install → activate。
 *
 * 这里刻意不跑构建命令：构建是用户自己的事（npm run build / gradle / dotnet publish），
 * 本工具只负责「把已经构建好的目录推上去」。这样它不绑定任何技术栈。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deployProfileTableSchema, type DeployProfile } from './contracts.ts';
import { packProject, type TreeManifest } from './archive.ts';
import { DeployError } from './errors.ts';

const PROFILE_ENV = 'AIRLOCK_DEPLOY_PROFILES';
const PROFILE_FILE_ENV = 'AIRLOCK_DEPLOY_PROFILES_FILE';
const PROFILE_FILE = 'config/deploy-profiles.json';
/** 用户级档案：这台机器上配过的所有项目，和仓库里的 config/ 合并。 */
const HOME_PROFILE_FILE = join(homedir(), '.airlock', 'deploy-profiles.json');
const execFileAsync = promisify(execFile);

type ProfileTable = { default?: string; profiles: Record<string, DeployProfile> };

function readProfileTableFile(path: string): { table: ProfileTable; baseDir: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new DeployError('INVALID_REQUEST', `档案文件不可读或不是 JSON：${path}`);
  }
  const parsed = deployProfileTableSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DeployError('INVALID_REQUEST', `档案不符合契约（${path}）：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return { table: parsed.data, baseDir: dirname(path) };
}

/** 相对 workspace 按它自己那份档案所在目录解析，合并后才不会互相串味。 */
function absolutizeWorkspace(profile: DeployProfile, baseDir: string): DeployProfile {
  const workspace = profile.workspace;
  if (workspace === undefined || isAbsolute(workspace)) return profile;
  return { ...profile, workspace: resolve(baseDir, workspace) };
}

export interface LoadedProfile {
  readonly name: string;
  readonly profile: DeployProfile;
  /** 档案文件所在目录，用于解析 workspace 的相对路径。 */
  readonly baseDir: string;
}

/**
 * 档案来源优先级（从高到低）：
 *   1. 显式 `--profiles <文件>`
 *   2. `AIRLOCK_DEPLOY_PROFILES_FILE` 指向的文件（适合全局放一份、所有项目共用）
 *   3. `AIRLOCK_DEPLOY_PROFILES` 内联 JSON
 *   4. `~/.airlock/deploy-profiles.json` 与当前目录的 `config/deploy-profiles.json` **合并**
 *
 * 优先级这样排的原因：显式参数 > 环境变量 > 约定位置，避免「明明指定了却读到别处」。
 * 两份约定位置合并而不是二选一：用户级放「我配过的所有项目」，仓库里那份放「这个仓库固定的项目」，
 * 谁都不该把对方盖掉。同名档案以仓库里的为准（离当前项目更近的那份更具体）。
 */
/**
 * 读整张档案表。控制台需要列出所有项目，所以解析逻辑单独抽出来，loadProfile 复用它。
 */
export function loadProfileTable(profilesPath?: string): { table: { default?: string; profiles: Record<string, DeployProfile> }; baseDir: string; source: string } {
  const explicitPath = profilesPath ?? process.env[PROFILE_FILE_ENV];
  const inline = process.env[PROFILE_ENV];
  let raw: unknown;
  let baseDir = process.cwd();
  let source = PROFILE_FILE;

  if (explicitPath !== undefined && explicitPath.trim() !== '') {
    const path = resolve(explicitPath.trim());
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new DeployError('INVALID_REQUEST', `档案文件不可读或不是 JSON：${path}`);
    }
    baseDir = dirname(path);
    source = path;
  } else if (inline !== undefined && inline.trim() !== '') {
    try {
      raw = JSON.parse(inline);
    } catch {
      throw new DeployError('INVALID_REQUEST', `${PROFILE_ENV} 不是合法 JSON`);
    }
    source = PROFILE_ENV;
  } else {
    const localPath = resolve(PROFILE_FILE);
    const layers = [HOME_PROFILE_FILE, localPath]
      .filter(path => existsSync(path))
      .map(path => readProfileTableFile(path));
    if (layers.length === 0) {
      throw new DeployError(
        'INVALID_REQUEST',
        `没有可用的档案：${PROFILE_FILE} 与 ~/.airlock/deploy-profiles.json 都不存在。配好其中一份，或用 --profiles <文件> / ${PROFILE_FILE_ENV} 指定，或设置 ${PROFILE_ENV}`,
      );
    }
    const merged: Record<string, DeployProfile> = {};
    for (const layer of layers) {
      for (const [name, profile] of Object.entries(layer.table.profiles)) {
        merged[name] = absolutizeWorkspace(profile, layer.baseDir);
      }
    }
    const nearest = layers[layers.length - 1];
    const defaultName = nearest?.table.default ?? layers[0]?.table.default;
    raw = { ...(defaultName === undefined ? {} : { default: defaultName }), profiles: merged };
    baseDir = nearest?.baseDir ?? process.cwd();
    // 「添加项目」写回离当前项目最近的那份，不污染用户级。
    source = existsSync(localPath) ? localPath : HOME_PROFILE_FILE;
  }
  const parsed = deployProfileTableSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DeployError('INVALID_REQUEST', `档案不符合契约（${source}）：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return { table: parsed.data, baseDir, source };
}

export function loadProfile(name?: string, profilesPath?: string): LoadedProfile {
  const { table, baseDir } = loadProfileTable(profilesPath);
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
