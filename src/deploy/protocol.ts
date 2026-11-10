/**
 * stdin 读取器：协议是「一行 JSON + 可选 N 字节二进制」，所以不能用 readline——
 * readline 会把后面的归档字节也当文本行吞掉。
 *
 * 这里自己管一个 chunk 队列：行读取按 \n 切，字节读取按长度切，两者共用同一个流。
 */
import type { Readable } from 'node:stream';
import { deployRequestSchema, type DeployRequest } from './contracts.ts';
import type { ArchiveReceiver } from './context.ts';
import { DeployError } from './errors.ts';

export class StreamReader implements ArchiveReceiver {
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  private waiters: Array<() => void> = [];

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      this.chunks.push(buffer);
      this.size += buffer.length;
      this.wake();
    });
    stream.on('end', () => { this.ended = true; this.wake(); });
    stream.on('error', () => { this.ended = true; this.wake(); });
    stream.on('close', () => { this.ended = true; this.wake(); });
  }

  private wake(): void {
    const list = this.waiters;
    this.waiters = [];
    for (const resolve of list) resolve();
  }

  private waitForData(): Promise<void> {
    return new Promise<void>(resolve => { this.waiters.push(resolve); });
  }

  private indexOfNewline(): number {
    let offset = 0;
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(10);
      if (index >= 0) return offset + index;
      offset += chunk.length;
    }
    return -1;
  }

  /** 从队头取走 n 字节；调用前必须保证 size >= n。 */
  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      if (head === undefined) break;
      const need = n - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.chunks.shift();
        this.size -= head.length;
      } else {
        head.copy(out, filled, 0, need);
        this.chunks[0] = head.subarray(need);
        this.size -= need;
        filled += need;
      }
    }
    return out;
  }

  async readBytes(n: number): Promise<Buffer> {
    if (!Number.isInteger(n) || n < 0) throw new Error(`非法字节数：${n}`);
    while (this.size < n && !this.ended) await this.waitForData();
    if (this.size < n) throw new Error(`期望 ${n} 字节，实际只剩 ${this.size}`);
    return this.take(n);
  }

  async readLine(): Promise<string | null> {
    for (;;) {
      const index = this.indexOfNewline();
      if (index >= 0) {
        const raw = this.take(index + 1);
        return raw.subarray(0, index).toString('utf8');
      }
      if (this.ended) {
        if (this.size === 0) return null;
        const rest = this.take(this.size).toString('utf8');
        return rest === '' ? null : rest;
      }
      await this.waitForData();
    }
  }
}

/** 解析一行请求。字段不合法一律 INVALID_REQUEST，不尝试猜测。 */
export function parseRequest(line: string): DeployRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new DeployError('INVALID_REQUEST', '请求不是合法 JSON');
  }
  const parsed = deployRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DeployError('INVALID_REQUEST', `请求不符合契约：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}
