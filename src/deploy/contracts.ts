/**
 * 发布通道契约：一条 SSH 连接上跑固定 op，本机只提交「应用 id + 版本号 + 归档字节」，
 * 不提交命令、不提交路径。所有可执行动作来自服务器本地配置的预注册命令。
 *
 * 与 remote-dev 的分工：那边管「改服务器上的文件」，这边管「把本地构建好的版本推上去」。
 * 两边共用同一种传输形态（stdin/stdout + 一行 JSON），但协议独立、版本号独立。
 */
import { z } from 'zod';

export const DEPLOY_PROTOCOL = 1;

/** 版本号同时也是 releases/ 下的目录名，所以字符集必须收紧到路径安全范围内。 */
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 应用 id 只能是小写短横线：写进配置、日志和 URL 参数，不允许出现路径分隔符。 */
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

export const DEPLOY_ERROR_CODES = [
  'INVALID_REQUEST',
  'APP_NOT_FOUND',
  'VERSION_INVALID',
  'VERSION_EXISTS',
  'VERSION_NOT_FOUND',
  'ARCHIVE_TOO_LARGE',
  'ARCHIVE_INVALID',
  'MANIFEST_MISMATCH',
  'STOP_FAILED',
  'START_FAILED',
  'INSTALL_FAILED',
  'HEALTH_FAILED',
  'NO_PREVIOUS_VERSION',
  'NO_CURRENT_RELEASE',
  'INTERNAL',
] as const;
export type DeployErrorCode = (typeof DEPLOY_ERROR_CODES)[number];

/**
 * 一条预注册命令。`cwd` 只能是 'current'（版本目录）或 'root'（应用根），
 * 不接受任意相对/绝对路径——否则等于把路径注入面重新打开。
 */
export const deployCommandSchema = z.object({
  command: z.string().min(1).max(260),
  args: z.array(z.string().max(400)).max(32).optional(),
  cwd: z.enum(['current', 'root']).optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
}).strict();
export type DeployCommand = z.infer<typeof deployCommandSchema>;

export const healthCheckSchema = z.object({
  /** 任一满足即可：url 用 HTTP 状态判断，command 用退出码判断。两个都给时先试 url。 */
  url: z.string().regex(/^https?:\/\//).max(400).optional(),
  command: deployCommandSchema.optional(),
  /** 期望的 HTTP 状态码；2xx 校验靠 expectStatus 区间，默认必须是 200。 */
  expectStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.number().int().min(200).max(600_000).optional(),
  intervalMs: z.number().int().min(50).max(10_000).optional(),
}).strict();
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export const appConfigSchema = z.object({
  /** 应用根目录（绝对路径）。releases/、backups/、current 都在它下面。 */
  root: z.string().min(1).max(400),
  runtime: z.object({
    start: deployCommandSchema,
    /** 不给 stop 就表示「不需要优雅停止」（例如进程已由外部守护接管）。 */
    stop: deployCommandSchema.optional(),
    /** 只用于状态展示，不参与发布决策。 */
    status: deployCommandSchema.optional(),
  }).strict(),
  health: healthCheckSchema.optional(),
  /** 解压后、激活前的准备命令（例如 npm ci --omit=dev），cwd 默认是版本目录。 */
  install: deployCommandSchema.optional(),
  keepReleases: z.number().int().min(1).max(50).optional(),
  /** 相对 root 的目录，发布前打包到 backups/<version>.tar.gz；空表示只回代码。 */
  backupPaths: z.array(z.string().min(1).max(200)).max(8).optional(),
  keepBackups: z.number().int().min(1).max(50).optional(),
  /** 回滚时是否把该版本的备份解回去。默认 false —— 数据恢复必须显式声明。 */
  restoreBackupOnRollback: z.boolean().optional(),
  /** 激活时是否自动执行 start。默认 true。 */
  startOnActivate: z.boolean().optional(),
}).strict();
export type AppConfig = z.infer<typeof appConfigSchema>;

export const deployerConfigSchema = z.object({
  serverId: z.string().regex(/^srv-[a-z0-9]{4,32}$/),
  /** 只影响链接类型与进程信号，不改变协议。缺省按当前系统推断。 */
  kind: z.enum(['linux', 'windows']).optional(),
  maxArchiveBytes: z.number().int().min(1024).max(2_147_483_648).optional(),
  apps: z.record(z.string(), appConfigSchema),
}).strict();
export type DeployerConfig = z.infer<typeof deployerConfigSchema>;

export const deployOps = ['status', 'list', 'install', 'activate', 'rollback', 'logs', 'list-dir', 'set-root', 'sysinfo'] as const;
export type DeployOp = (typeof deployOps)[number];

export const deployRequestSchema = z.object({
  v: z.literal(DEPLOY_PROTOCOL),
  id: z.number().int().nonnegative(),
  op: z.enum(deployOps),
  app: z.string().regex(APP_ID_RE).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** 仅 install：紧随这一行之后还有这么多字节的 tar.gz。 */
  archiveSize: z.number().int().nonnegative().optional(),
}).strict();
export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const deployErrorSchema = z.object({
  code: z.enum(DEPLOY_ERROR_CODES),
  message: z.string().max(300),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

export const deployResponseSchema = z.object({
  v: z.literal(DEPLOY_PROTOCOL),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: deployErrorSchema.optional(),
}).strict();
export type DeployResponse = z.infer<typeof deployResponseSchema>;

/** 单个版本在 state.json 里的记录。`status` 只表达发布结果，不表达进程健康。 */
export const releaseRecordSchema = z.object({
  version: z.string().regex(VERSION_RE),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  commit: z.string().max(64).nullable(),
  status: z.enum(['installed', 'deployed', 'failed', 'rolled_back']),
  createdAt: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative().nullable(),
  backup: z.string().nullable(),
  note: z.string().max(300),
}).strict();
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export const appStateSchema = z.object({
  current: z.string().regex(VERSION_RE).nullable(),
  history: z.array(releaseRecordSchema).max(200),
}).strict();
export type AppState = z.infer<typeof appStateSchema>;

export const STATE_VERSION = 1;

/** 一台服务器的连接信息。多个项目可以共用同一台服务器。 */
export const deployServerSchema = z.object({
  host: z.string().min(1).max(260),
  user: z.string().max(64).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().max(400).optional(),
  userKnownHostsFile: z.string().max(400).optional(),
  hostKeyChecking: z.enum(['yes', 'accept-new']).optional(),
  serverId: z.string().max(64).optional(),
  /** 服务器侧 deployer 入口，例：node /opt/airlock/bin/airlock-deployer.mjs --config /etc/airlock/deployer.json */
  deployerCommand: z.string().min(1).max(500),
}).strict();
export type DeployServer = z.infer<typeof deployServerSchema>;

/** 解析后的完整档案：连接信息齐全，可以直接建客户端。 */
export const deployProfileSchema = z.object({
  host: z.string().min(1).max(260),
  user: z.string().max(64).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().max(400).optional(),
  userKnownHostsFile: z.string().max(400).optional(),
  hostKeyChecking: z.enum(['yes', 'accept-new']).optional(),
  serverId: z.string().max(64).optional(),
  /** 该档案默认发布的应用 id。同一台服务器跑多个应用时，每个应用各配一个档案。 */
  app: z.string().regex(APP_ID_RE).optional(),
  deployerCommand: z.string().min(1).max(500),
  /** 默认本地项目目录（相对 profile 文件所在目录或绝对路径）。 */
  workspace: z.string().max(400).optional(),
}).strict();
export type DeployProfile = z.infer<typeof deployProfileSchema>;

/**
 * 档案文件里的一条。连接信息可以只写 `server` 引用 servers 里的条目，
 * 也可以内联（老档案就是这么写的，保持兼容）。内联字段优先于引用的服务器。
 */
export const deployProfileInputSchema = z.object({
  server: z.string().min(1).max(64).optional(),
  host: z.string().min(1).max(260).optional(),
  user: z.string().max(64).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().max(400).optional(),
  userKnownHostsFile: z.string().max(400).optional(),
  hostKeyChecking: z.enum(['yes', 'accept-new']).optional(),
  serverId: z.string().max(64).optional(),
  app: z.string().regex(APP_ID_RE).optional(),
  deployerCommand: z.string().min(1).max(500).optional(),
  workspace: z.string().max(400).optional(),
}).strict();
export type DeployProfileInput = z.infer<typeof deployProfileInputSchema>;

export const deployProfileTableSchema = z.object({
  default: z.string().min(1).max(64).optional(),
  /** 所有可用服务器。项目和「服务器」下拉都从这里取。 */
  servers: z.record(z.string(), deployServerSchema).optional(),
  profiles: z.record(z.string(), deployProfileInputSchema),
}).strict();
export type DeployProfileTable = z.infer<typeof deployProfileTableSchema>;
