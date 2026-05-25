import type { ExecuteResult } from './types.js';
import type { ErrorCode } from '../error-codes.js';
import { getAppErrorCode, getErrorMessage } from '../utils/error.js';

export function toolError(errorCode: ErrorCode, error: string): ExecuteResult {
  return {
    ok: false,
    output: '',
    errorCode,
    error,
  };
}

export function catchToolError(
  error: unknown,
  fallback: ErrorCode = 'execution_failed',
): ExecuteResult {
  return toolError(getAppErrorCode(error) ?? fallback, getErrorMessage(error));
}
