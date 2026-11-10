/**
 * Airlock 远程通道契约 —— 协议形状与稳定枚举。
 *
 * 这里只定义「形状与稳定枚举」，不做 IO，不含凭据：
 * - 私钥、SSH 口令、令牌一律不进本文件，也不进任何返回给客户端/模型的视图；
 * - 版本号只加不改名：已发布的枚举值被删掉等于破坏调用方契约；
 * - 错误码是调用方唯一可分支的依据，不按 message 文本匹配。
 *
 * 依赖方向：contracts 不 import 本仓其它层，transport 与 CLI/MCP 都可读它。
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';

/** 预注册的宿主服务槽位。客户端、MCP 都不能提交命令、路径或单元名。 */
export const HOST_SERVICES = ['app', 'worker', 'scheduler', 'gateway'] as const;
export const HOST_ACTIONS = ['restart', 'reload', 'status'] as const;
/** 恢复策略必须显式声明；`code-only` 只在「无不可逆迁移」时被接受。 */
export const ROLLBACK_STRATEGIES = ['code-only', 'restore-backup', 'manual'] as const;

export type HostServiceId = (typeof HOST_SERVICES)[number];
export type HostActionId = (typeof HOST_ACTIONS)[number];
export type RollbackStrategy = (typeof ROLLBACK_STRATEGIES)[number];

/** 开发通道协议版本。客户端与 Broker 版本不一致必须直接拒绝，不做兼容猜测。 */
export const REMOTE_DEV_PROTOCOL = 1;

/** 开发通道错误码。Broker 只回这些码，调用方按码分支，不匹配 message 文本。 */
export const DEV_ERROR_CODES = [
  'INVALID_REQUEST',
  'PROTOCOL_MISMATCH',
  'LEASE_REQUIRED',
  'LEASE_CONFLICT',
  'PATH_OUT_OF_SCOPE',
  'HASH_MISMATCH',
  'TOO_LARGE',
  'UNKNOWN_TASK',
  'JOB_NOT_FOUND',
  'DUPLICATE_OPERATION',
  'RELEASE_EXISTS',
  'WRITE_DISABLED',
  'INTERNAL',
] as const;
export type DevErrorCode = (typeof DEV_ERROR_CODES)[number];

const serverId = z.string().regex(/^srv-[a-z0-9]{4,32}$/);
const workspaceId = z.string().regex(/^ws-[a-z0-9]{3,32}$/);
const releaseId = z.string().regex(/^rel-[a-z0-9]{6,32}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const epochMs = z.number().int().nonnegative();

/** 发布检查记录。`task` 只能是 Broker 配置里登记过的任务名。 */
export const releaseCheckSchema = z.object({
  task: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  ok: z.boolean(),
  at: epochMs,
  /** 检查输出的摘要，不存完整日志（日志可能含本机路径或正文）。 */
  outputDigest: sha256.nullable(),
}).strict();
export type ReleaseCheck = z.infer<typeof releaseCheckSchema>;

/** 发布申请：冻结出来的内容摘要 + 检查记录。哈希绑定不可变版本，检查后改代码会让批准失效。 */
export const releaseRequestSchema = z.object({
  releaseId,
  profileId: z.string().min(1).max(32),
  workspaceId,
  frozenHash: sha256,
  contentDigest: sha256,
  commit: z.string().max(64).nullable(),
  files: z.number().int().nonnegative(),
  diff: z.object({ added: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).strict(),
  checks: z.array(releaseCheckSchema).max(32),
  migration: z.object({ required: z.boolean(), notes: z.string().max(500).nullable() }).strict(),
  rollback: z.object({ strategy: z.enum(ROLLBACK_STRATEGIES), notes: z.string().max(500).nullable() }).strict(),
  requestedBy: z.string().min(1).max(64),
  at: epochMs,
}).strict();
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;

// ── 开发通道（本机工具 ↔ 服务器 Broker，JSON Lines over stdio）──────

export const devOps = [
  'status', 'lease-acquire', 'lease-release', 'list', 'read', 'apply',
  'git-status', 'git-diff', 'check', 'job-status', 'job-cancel', 'release-request',
] as const;
export const devRequestSchema = z.object({
  v: z.literal(REMOTE_DEV_PROTOCOL),
  id: z.number().int().nonnegative(),
  op: z.enum(devOps),
  leaseId: z.string().min(8).max(64).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type DevRequest = z.infer<typeof devRequestSchema>;

export const devErrorSchema = z.object({
  code: z.enum(DEV_ERROR_CODES),
  message: z.string().max(300),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

export const devResponseSchema = z.object({
  v: z.literal(REMOTE_DEV_PROTOCOL),
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: devErrorSchema.optional(),
}).strict();
export type DevResponse = z.infer<typeof devResponseSchema>;

/** `status` 的 data：服务器身份、工作区版本与当前租约，是每次接续的第一个调用。 */
export const devStatusSchema = z.object({
  protocol: z.literal(REMOTE_DEV_PROTOCOL),
  serverId,
  workspaceId,
  root: z.string().max(260),
  version: z.string().max(64),
  bootId: z.string().max(64),
  writable: z.boolean(),
  lease: z.object({ id: z.string().max(64), owner: z.string().max(64), expiresAt: epochMs }).strict().nullable(),
  tasks: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/)).max(32),
  observedAt: epochMs,
}).strict();
export type DevStatus = z.infer<typeof devStatusSchema>;

export const devFileEntrySchema = z.object({
  path: z.string().min(1).max(400),
  kind: z.enum(['file', 'dir', 'symlink']),
  size: z.number().int().nonnegative(),
  hash: sha256.nullable(),
}).strict();
export type DevFileEntry = z.infer<typeof devFileEntrySchema>;

export const devReadSchema = z.object({
  path: z.string().min(1).max(400),
  hash: sha256,
  content: z.string(),
  truncated: z.boolean(),
}).strict();
export type DevRead = z.infer<typeof devReadSchema>;

/** 写入结果。`changed=false` 表示幂等命中（同 operationId 或内容已一致）。 */
export const devApplyResultSchema = z.object({
  path: z.string().min(1).max(400),
  hashBefore: sha256.nullable(),
  hashAfter: sha256,
  changed: z.boolean(),
  operationId: z.string().min(8).max(64),
}).strict();
export type DevApplyResult = z.infer<typeof devApplyResultSchema>;

export const devJobSchema = z.object({
  jobId: z.string().min(8).max(64),
  task: z.string().min(1).max(32),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']),
  startedAt: epochMs.nullable(),
  finishedAt: epochMs.nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(8000),
}).strict();
export type DevJob = z.infer<typeof devJobSchema>;

/**
 * releaseId 与冻结内容绑定：Broker 生成、审批侧复核，两边必须用同一个派生函数。
 * 只取 12 位十六进制：它用于人眼核对与唯一性，不用于安全校验（安全靠 frozenHash 全值）。
 */
export function deriveReleaseId(frozenHash: string, contentDigest: string): string {
  return `rel-${createHash('sha256').update(`${frozenHash}:${contentDigest}`).digest('hex').slice(0, 12)}`;
}
