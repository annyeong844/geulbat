import { z } from 'zod';
import {
  PTC_EXECUTE_CODE_DEFAULT_TIMEOUT_MS,
  PTC_EXECUTE_CODE_MAX_CODE_BYTES,
  PTC_EXECUTE_CODE_MAX_TIMEOUT_MS,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntimeFailureReason,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeSummary,
} from '../../daemon-runtime-contract.js';
import { createRunWorkspaceContext } from '../../run-workspace-context.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  createPtcExecuteCodeToolCallbackHandler,
  createPtcExecuteCodeToolCallbackHelp,
} from './execute-code-tool-callback.js';

const executeCodeArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1, 'code is required.')
    .max(PTC_EXECUTE_CODE_MAX_CODE_BYTES)
    .describe(
      'JavaScript code to run inside the PTC lab Docker runtime. Use stdout or return a JSON-serializable value for compact results.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(PTC_EXECUTE_CODE_MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Execution timeout in milliseconds. Defaults to ${PTC_EXECUTE_CODE_DEFAULT_TIMEOUT_MS}.`,
    ),
});

type ExecuteCodeArgs = z.output<typeof executeCodeArgsSchema>;

export const executeCodeTool = defineZodTool({
  name: PTC_EXECUTE_CODE_TOOL_NAME,
  description:
    'Run JavaScript code inside the PTC lab Docker runtime and return a compact stdout/stderr result. Code can call geulbat.callTool(name, args) for read-only daemon tools.',
  argsSchema: executeCodeArgsSchema,
  sideEffectLevel: 'none',
  mayMutateWorkspaceFiles: false,
  timeoutMs: PTC_EXECUTE_CODE_MAX_TIMEOUT_MS,
  requiresApproval: false,
  async executeParsed(args: ExecuteCodeArgs, ctx) {
    if (!ctx.threadId || !ctx.projectId) {
      return toolError(
        'execution_failed',
        'run context is required for execute_code.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.ptcExecuteCode;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'PTC execute_code runtime is required.',
      );
    }

    const toolCallbackHandler = createPtcExecuteCodeToolCallbackHandler(ctx);
    const sdkHelp = createPtcExecuteCodeToolCallbackHelp(ctx);
    const runtimeArgs = {
      runContext: createRunWorkspaceContext({
        threadId: ctx.threadId,
        projectId: ctx.projectId,
        workspaceRoot: ctx.workspaceRoot,
      }),
      request: {
        code: args.code,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
      ...(sdkHelp ? { sdkHelp } : {}),
      ...(toolCallbackHandler ? { toolCallbackHandler } : {}),
    };
    const result = await runtime.executeCode(
      ctx.signal === undefined
        ? runtimeArgs
        : { ...runtimeArgs, signal: ctx.signal },
    );
    if (!result.ok) {
      return {
        ok: false,
        output: stringifyExecuteCodeFailure(result),
        errorCode: executeCodeFailureToToolErrorCode(result.reasonCode),
        error: result.message,
      };
    }

    return {
      ok: true,
      output: stringifyExecuteCodeSummary(result.value),
    };
  },
});

function stringifyExecuteCodeSummary(
  summary: PtcExecuteCodeRuntimeSummary,
): string {
  return JSON.stringify({
    kind: 'ptc_execute_code_result',
    capabilityId: summary.capabilityId,
    policyId: summary.policyId,
    labPolicyId: summary.labPolicyId,
    profile: summary.profile,
    executionClass: summary.executionClass,
    executionSurface: summary.executionSurface,
    exitCode: summary.exitCode,
    stdout: summary.stdout,
    stderr: summary.stderr,
    stdoutTruncated: summary.stdoutTruncated,
    stderrTruncated: summary.stderrTruncated,
    effectiveTimeoutMs: summary.effectiveTimeoutMs,
    durationMs: summary.durationMs,
    toolCallbacks: summary.toolCallbacks,
    sessionLifecycle: summary.sessionLifecycle,
    callbackHelp: summary.callbackHelp,
  });
}

function stringifyExecuteCodeFailure(
  failure: Extract<PtcExecuteCodeRuntimeResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: 'ptc_execute_code_error',
    reasonCode: failure.reasonCode,
    message: failure.message,
    diagnostics: sanitizeFailureDiagnostics(failure.diagnostics),
  });
}

function sanitizeFailureDiagnostics(
  diagnostics: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  const safe: Record<string, string | number | boolean> = {};
  for (const key of [
    'admissionReasonCode',
    'bridgeReasonCode',
    'sessionReasonCode',
    'cleanupReasonCode',
    'taintHookFailed',
    'sessionCloseFailed',
    'callbackBridgeCloseFailed',
    'executeCodeRuntimeThrew',
  ]) {
    const value = diagnostics[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function executeCodeFailureToToolErrorCode(
  reasonCode: PtcExecuteCodeRuntimeFailureReason,
): ErrorCode {
  switch (reasonCode) {
    case 'ptc_execute_code_invalid':
    case 'ptc_execute_code_callback_bridge_unavailable':
    case 'ptc_execute_code_lab_admission_failed':
    case 'ptc_lab_admission_required':
    case 'ptc_lab_shell_disabled':
    case 'ptc_lab_policy_mismatch':
    case 'ptc_lab_command_invalid':
      return 'invalid_args';
    case 'ptc_lab_command_timeout':
      return 'timeout';
    case 'ptc_lab_command_cancelled':
      return 'aborted';
    case 'ptc_lab_session_busy':
      return 'conflict';
    case 'ptc_lab_interpreter_unavailable':
    case 'ptc_lab_session_unavailable':
    case 'ptc_lab_command_failed':
    case 'ptc_lab_command_output_invalid':
    case 'ptc_execute_code_session_cleanup_failed':
      return 'execution_failed';
  }
}
