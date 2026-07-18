// Plugin store 계약 leaf — 에러/코드와 안전 메시지 셰이퍼(경로 등 민감
// 정보를 숨기고 errno 코드만 부착). store 본체와 managed-directory 가드,
// 외부 소비자(routes·mcp-coordinator)가 이 leaf에서 직접 import한다
// (re-export 금지 정책).
import { getErrorCode } from '../utils/error.js';

type PluginStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'corrupt_registry';

export class PluginStoreError extends Error {
  constructor(
    readonly code: PluginStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginStoreError';
  }
}

export function safeStorageError(message: string, error: unknown): Error {
  return new Error(safeErrorMessage(message, error));
}

export function safeErrorMessage(message: string, error: unknown): string {
  const errorCode = getErrorCode(error);
  return errorCode ? `${message} (${errorCode})` : message;
}
