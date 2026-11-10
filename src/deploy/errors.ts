/**
 * 发布通道错误。协议层只把 code/message/detail 发回本机，堆栈与服务器路径不外泄。
 */
import type { DeployErrorCode } from './contracts.ts';

export class DeployError extends Error {
  readonly code: DeployErrorCode;
  readonly detail?: Record<string, string | number | boolean | null>;

  constructor(code: DeployErrorCode, message: string, detail?: Record<string, string | number | boolean | null>) {
    super(message);
    this.name = 'DeployError';
    this.code = code;
    this.detail = detail;
  }
}

export function isDeployError(error: unknown): error is DeployError {
  return error instanceof DeployError;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
