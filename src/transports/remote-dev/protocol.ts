/**
 * 开发通道线协议：JSON Lines 编解码。
 *
 * 复用 `core/contracts/remote.ts` 的 zod schema，不在这里另写一套字段校验：
 * 两套 schema 一旦分叉，Broker 放行而 Core 拒绝的请求就会出现，且排查方向会被引到传输层。
 *
 * 三条硬规则：
 * 1. 单行上限 1MB。超过直接回 INVALID_REQUEST——若不设上限，一个畸形客户端就能把内存吃满。
 * 2. 解析失败**不抛异常**：远端只会看到连接被重置，而真正原因是那行 JSON 非法。
 * 3. 版本不符单独回 PROTOCOL_MISMATCH，不尝试兼容：字段语义变了以后静默兼容会写坏工作区。
 */
import {
  devRequestSchema,
  devResponseSchema,
  REMOTE_DEV_PROTOCOL,
} from '../../contracts/remote.ts';
import type { DevErrorCode, DevRequest, DevResponse } from '../../contracts/remote.ts';

/** 单行字节上限（按 UTF-8 计算，不是字符数：中文一行能差三倍）。 */
export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * 开发通道的统一错误。Broker 全层只抛它，由分发层转成 `devErrorSchema`；
 * 传输层没有自己的错误码字典，避免出现「契约里有码但代码里另起一套」的分叉。
 */
export class RemoteDevError extends Error {
  readonly code: DevErrorCode;
  readonly detail: Record<string, string | number | boolean | null> | undefined;

  constructor(code: DevErrorCode, message: string, detail?: Record<string, string | number | boolean | null>) {
    super(message);
    this.name = 'RemoteDevError';
    this.code = code;
    this.detail = detail;
  }
}

export type ParsedLine =
  | { readonly kind: 'blank' }
  | { readonly kind: 'request'; readonly request: DevRequest }
  | { readonly kind: 'invalid'; readonly response: DevResponse };

export type ParsedResponse =
  | { readonly kind: 'response'; readonly response: DevResponse }
  | { readonly kind: 'protocol-mismatch'; readonly id: number }
  | { readonly kind: 'invalid' };

/** 编码带换行：JSON Lines 的「行」由调用方原样写进流，不在这里做拼接。 */
export function encodeRequest(request: DevRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeResponse(response: DevResponse): string {
  return `${JSON.stringify(response)}\n`;
}

/** 构造错误响应。id 是回显用的，协议版本字段必须是当前版本，否则客户端会判成版本不符。 */
export function errorResponse(
  id: number,
  code: DevErrorCode,
  message: string,
  detail?: Record<string, string | number | boolean | null>,
): DevResponse {
  const trimmed = message.length > 300 ? `${message.slice(0, 299)}…` : message;
  return { v: REMOTE_DEV_PROTOCOL, id, ok: false, error: detail === undefined ? { code, message: trimmed } : { code, message: trimmed, detail } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从任意值里尽力取一个合法的请求 id：取不到就 0，客户端靠 0 号响应丢弃无法归属的回复。 */
function idOf(value: unknown): number {
  if (!isRecord(value)) return 0;
  const id = value.id;
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : 0;
}

/**
 * 解析一行请求。
 * - 空行返回 `blank`（调用方直接跳过，不回包；回包会让客户端把它当成对下一条的回复）；
 * - 超长/非 JSON/字段不合法 → `invalid` + INVALID_REQUEST 响应；
 * - 版本不符 → `invalid` + PROTOCOL_MISMATCH（id 尽量回显，方便客户端失败在正确的请求上）。
 */
export function parseLine(line: string): ParsedLine {
  const text = line.trim();
  if (text === '') return { kind: 'blank' };
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
    return { kind: 'invalid', response: errorResponse(0, 'INVALID_REQUEST', `单行超过 ${MAX_LINE_BYTES} 字节上限`) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', response: errorResponse(0, 'INVALID_REQUEST', '不是合法的 JSON 行') };
  }
  if (!isRecord(value)) {
    return { kind: 'invalid', response: errorResponse(0, 'INVALID_REQUEST', '请求必须是 JSON 对象') };
  }
  if (value.v !== REMOTE_DEV_PROTOCOL) {
    return {
      kind: 'invalid',
      response: errorResponse(idOf(value), 'PROTOCOL_MISMATCH', `协议版本不符：需要 ${REMOTE_DEV_PROTOCOL}，收到 ${String(value.v)}`),
    };
  }
  const parsed = devRequestSchema.safeParse(value);
  if (!parsed.success) {
    // zod 的 issue 可能回显用户输入原文；只回字段路径，不回值（params 里可能有文件正文）。
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    return { kind: 'invalid', response: errorResponse(idOf(value), 'INVALID_REQUEST', path === '' ? '请求结构不符合契约' : `请求结构不符合契约：${path}`) };
  }
  return { kind: 'request', request: parsed.data };
}

/**
 * 解析一行响应（客户端侧）。版本不符单独成类而不是直接当非法：
 * 客户端要把 PROTOCOL_MISMATCH 精确地挂到发起请求的那条上，否则调用方只能看到超时。
 */
export function parseResponse(line: string): ParsedResponse {
  const text = line.trim();
  if (text === '') return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value)) return { kind: 'invalid' };
  if (value.v !== REMOTE_DEV_PROTOCOL) return { kind: 'protocol-mismatch', id: idOf(value) };
  const parsed = devResponseSchema.safeParse(value);
  return parsed.success ? { kind: 'response', response: parsed.data } : { kind: 'invalid' };
}
