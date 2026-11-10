/**
 * Airlock 统一错误码与错误类型 —— 本仓库唯一的错误码字典。
 *
 * 契约要点：
 * 1. 码值是字符串常量，一旦发布不再改名；删除一个码等于破坏调用方契约。
 * 2. 调用方只允许按 `code` 分支，禁止匹配 message 文本。
 * 3. `message` 给人看，`detail` 给排查用（必须可 JSON 序列化），原始异常放 `cause`。
 * 4. 禁止把凭据（口令、私钥、令牌）放进 message 或 detail。
 */

/** 错误码字典。`as const` 而非 enum：Node 原生类型剥离不支持 enum。 */
export const ErrorCode = {
  /** 单次请求超时。结果未知：请求可能已被执行，重试前先确认 operationId 幂等。 */
  TRANSPORT_TIMEOUT: 'TRANSPORT_TIMEOUT',
  /** 通道已关闭或发送失败。可重连后重试；写操作仍需带同一 operationId。 */
  TRANSPORT_DISCONNECTED: 'TRANSPORT_DISCONNECTED',
  /** 调用方参数不合法（缺字段、类型不符、取值越界）。不重试。 */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** 未预期内部错误。服务端只回简短说明，不回堆栈。 */
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 可 JSON 序列化的排查上下文。禁止放凭据。 */
export type ErrorDetail = Record<string, string | number | boolean | null>;

/** 选项对象。用普通对象而非参数属性（Node 类型剥离不支持参数属性）。 */
export interface AirlockErrorOptions {
  readonly detail?: ErrorDetail;
  readonly cause?: unknown;
}

/** 本仓库统一错误类型。`instanceof AirlockError` 成立，`Error` 语义完整。 */
export class AirlockError extends Error {
  readonly code: ErrorCode;
  readonly detail: ErrorDetail | undefined;

  constructor(code: ErrorCode, message: string, options: AirlockErrorOptions = {}) {
    super(message);
    this.name = 'AirlockError';
    this.code = code;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 类型守卫。用于 catch 块里把 unknown 收窄成 AirlockError。 */
export function isAirlockError(err: unknown): err is AirlockError {
  return err instanceof AirlockError;
}

/** 判断是否为指定错误码。`hasErrorCode(e, ErrorCode.TRANSPORT_TIMEOUT)`。 */
export function hasErrorCode(err: unknown, code: ErrorCode): boolean {
  return isAirlockError(err) && err.code === code;
}

/**
 * 把任意抛出物包成 AirlockError。
 * 已经是 AirlockError 时原样返回——避免包装两层后丢失原始 code。
 */
export function toAirlockError(err: unknown, code: ErrorCode, message: string): AirlockError {
  if (isAirlockError(err)) return err;
  return new AirlockError(code, message, { cause: err });
}
