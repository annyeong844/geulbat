import {
  isToolFailureDiagnostics,
  type ToolFailureDiagnostics,
} from '@geulbat/protocol/errors';
import type { ExecuteResult } from './types.js';
import type { ErrorCode } from '../error-codes.js';
import { getAppErrorCode, getErrorMessage } from '../utils/error.js';

export function toolError(
  errorCode: ErrorCode,
  error: string,
  diagnostics?: ToolFailureDiagnostics,
): ExecuteResult {
  return {
    ok: false,
    output: '',
    errorCode,
    error,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function readToolFailureDiagnostics(
  error: unknown,
): ToolFailureDiagnostics | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('toolFailureDiagnostics' in error)
  ) {
    return undefined;
  }

  return isToolFailureDiagnostics(error.toolFailureDiagnostics)
    ? error.toolFailureDiagnostics
    : undefined;
}

export function catchToolError(
  error: unknown,
  fallback: ErrorCode = 'execution_failed',
): ExecuteResult {
  return toolError(
    getAppErrorCode(error) ?? fallback,
    getErrorMessage(error),
    readToolFailureDiagnostics(error),
  );
}
