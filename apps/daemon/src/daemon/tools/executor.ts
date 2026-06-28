/**
 * Tool executor — AbortSignal-based timeout + fail-closed approval.
 * Ported from v1 with workspaceRoot per-call context.
 */

import { isRecord } from '@geulbat/protocol/runtime-utils';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { ToolResolver } from './tool-registry-model.js';
import type { ToolExecutionContext, ExecuteResult } from './types.js';
import { toolError } from './result.js';
import { createMergedAbortSignal } from '../utils/abort.js';
import { getErrorCode, getErrorMessage } from '../utils/error.js';
import { isErrorCode, type ErrorCode } from '../error-codes.js';

const SAFE_TOOL_ERROR_CODES = new Set<ErrorCode>([
  'unknown_tool',
  'invalid_args',
  'invalid_path',
  'not_found',
  'already_exists',
  'path_out_of_workspace',
  'access_denied',
  'binary_file',
  'buffer_limit_exceeded',
  'unsupported_mode',
  'conflict_stale_write',
]);
const logger = createLogger('tool-executor');

function sanitizeExecutionErrorMessage(
  name: string,
  code: ErrorCode,
  err: unknown,
): string {
  const message = readErrorMessage(err);
  if (
    SAFE_TOOL_ERROR_CODES.has(code) &&
    message !== undefined &&
    message.trim() !== ''
  ) {
    return message;
  }
  return `tool "${name}" execution failed`;
}

function readErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : undefined;
}

function sanitizeToolExecuteResult(
  name: string,
  result: ExecuteResult,
): ExecuteResult {
  if (result.ok) {
    return result;
  }
  return toolError(
    result.errorCode,
    sanitizeExecutionErrorMessage(name, result.errorCode, result.error),
  );
}

function classifyToolExecutionFailure(
  name: string,
  err: unknown,
): { errorCode: ErrorCode; error: string } {
  const code = getErrorCode(err);
  const errorCode =
    isErrorCode(code) && SAFE_TOOL_ERROR_CODES.has(code)
      ? code
      : 'execution_failed';
  return {
    errorCode,
    error: sanitizeExecutionErrorMessage(name, errorCode, err),
  };
}

function logUnexpectedToolFailure(args: {
  name: string;
  callId: string;
  errorCode: ErrorCode;
  err: unknown;
}): void {
  if (args.errorCode === 'execution_failed') {
    logger.warn('unexpected tool failure:', {
      tool: args.name,
      callId: args.callId,
      errorCode: args.errorCode,
      cause: getErrorMessage(args.err),
    });
  }
}

function classifyAbortOutcome(args: {
  name: string;
  callerSignal: AbortSignal | undefined;
  timeoutSignal: AbortSignal | undefined;
  timeoutMs: number | undefined;
}): ExecuteResult {
  if (args.callerSignal?.aborted) {
    return toolError('aborted', 'client disconnected');
  }
  if (args.timeoutSignal?.aborted && args.timeoutMs !== undefined) {
    return toolError(
      'timeout',
      `tool "${args.name}" timed out (${args.timeoutMs}ms)`,
    );
  }
  return toolError('aborted', 'tool aborted');
}

function isExecuteResult(value: unknown): value is ExecuteResult {
  if (!isRecord(value)) {
    return false;
  }

  const candidate = value as Partial<ExecuteResult>;
  if (candidate.ok === true) {
    return (
      typeof candidate.output === 'string' &&
      candidate.errorCode === undefined &&
      candidate.error === undefined
    );
  }

  if (candidate.ok === false) {
    return (
      typeof candidate.output === 'string' &&
      isErrorCode(candidate.errorCode) &&
      typeof candidate.error === 'string'
    );
  }

  return false;
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolExecutionContext,
  options: {
    toolRegistry?: ToolResolver;
  },
): Promise<ExecuteResult> {
  if (!options.toolRegistry) {
    throw new Error('toolRegistry is required');
  }
  const tool = options.toolRegistry.getTool(name);

  if (!tool) {
    return toolError('unknown_tool', `unknown tool: ${name}`);
  }

  let parsedArgs: object;
  try {
    const parsed = tool.parseArgs(args);
    if (!parsed.ok) {
      return toolError('invalid_args', parsed.message);
    }
    parsedArgs = parsed.value;
  } catch (err: unknown) {
    const failure = classifyToolExecutionFailure(name, err);
    logUnexpectedToolFailure({
      name,
      callId: ctx.callId,
      errorCode: failure.errorCode,
      err,
    });
    return toolError(failure.errorCode, failure.error);
  }

  // Fail-closed: approval-required tools cannot execute without explicit grant
  if (tool.requiresApproval && ctx.approvalGranted !== true) {
    return toolError('approval_required', `tool "${name}" requires approval`);
  }

  // AbortSignal-based timeout. Omitted timeoutMs means the tool relies only on
  // caller/run cancellation.
  const timeoutController =
    tool.timeoutMs !== undefined ? new AbortController() : null;
  const timeout =
    timeoutController && tool.timeoutMs !== undefined
      ? setTimeout(() => timeoutController.abort(), tool.timeoutMs)
      : null;

  const mergedSignal =
    ctx.signal && timeoutController
      ? createMergedAbortSignal(ctx.signal, timeoutController.signal)
      : null;
  const combinedSignal =
    mergedSignal?.signal ?? timeoutController?.signal ?? ctx.signal;

  const execCtx: ToolExecutionContext = combinedSignal
    ? {
        ...ctx,
        // `signal` is the per-tool watchdog signal; `runSignal` preserves the
        // original run-level abort path so tools can tell timeout from run cancel.
        signal: combinedSignal,
      }
    : ctx;
  let abortHandler: (() => void) | undefined;

  try {
    // Watchdog: if abort fires after tool resolves, still treat as abort
    const execution = tool.executeParsed(parsedArgs, execCtx).then((raw) => {
      if (combinedSignal?.aborted) return undefined;
      return raw;
    });
    const result = combinedSignal
      ? await Promise.race([
          execution,
          new Promise<undefined>((resolve) => {
            abortHandler = () => resolve(undefined);
            combinedSignal.addEventListener('abort', abortHandler, {
              once: true,
            });
          }),
        ])
      : await execution;

    if (combinedSignal?.aborted) {
      return classifyAbortOutcome({
        name,
        callerSignal: ctx.signal,
        timeoutSignal: timeoutController?.signal,
        timeoutMs: tool.timeoutMs,
      });
    }

    if (result === undefined) {
      return toolError(
        'execution_failed',
        `tool "${name}" failed without a result`,
      );
    }

    if (!isExecuteResult(result)) {
      return toolError(
        'execution_failed',
        `tool "${name}" returned an invalid result`,
      );
    }

    return sanitizeToolExecuteResult(name, result);
  } catch (err: unknown) {
    if (combinedSignal?.aborted) {
      return classifyAbortOutcome({
        name,
        callerSignal: ctx.signal,
        timeoutSignal: timeoutController?.signal,
        timeoutMs: tool.timeoutMs,
      });
    }
    const failure = classifyToolExecutionFailure(name, err);
    logUnexpectedToolFailure({
      name,
      callId: ctx.callId,
      errorCode: failure.errorCode,
      err,
    });
    return toolError(failure.errorCode, failure.error);
  } finally {
    if (abortHandler && combinedSignal) {
      combinedSignal.removeEventListener('abort', abortHandler);
    }
    if (timeout) {
      clearTimeout(timeout);
    }
    mergedSignal?.cleanup();
  }
}
