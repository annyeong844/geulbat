import { z } from 'zod';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntimeFailureReason,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeSummary,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { createRunWorkspaceContext } from '../../run-workspace-context.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  createPtcExecuteCodeToolCallbackHandler,
  createPtcExecuteCodeToolCallbackHelp,
  createPtcExecuteCodeToolCallbackSurface,
} from './execute-code-tool-callback.js';

const executeCodeArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1, 'code is required.')
    .describe(
      'JavaScript code to run inside the PTC lab Docker runtime. Use stdout or return a JSON-serializable value for compact results.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Optional execution timeout in milliseconds. Use the exact key timeoutMs; timeout_ms is not accepted. Omitted requests use the admitted PTC lab shell policy.',
    ),
  yield_time_ms: z
    .number()
    .int()
    .min(PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS)
    .max(PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS)
    .optional()
    .describe(
      'Optional initial observation window in milliseconds for detached exec cells. Use the exact key yield_time_ms; yieldTimeMs is not accepted. If exec returns status "running", call wait with the returned cellId.',
    ),
});

type ExecuteCodeArgs = z.output<typeof executeCodeArgsSchema>;

export const executeCodeTool = defineZodTool({
  name: PTC_EXECUTE_CODE_TOOL_NAME,
  description:
    'Run JavaScript code inside the PTC lab Docker runtime. Code can call geulbat.callTool(name, args) for read-only daemon tools. If the result has status "running" and a cellId, call wait with cell_id set to that cellId to observe completion or terminate the cell.',
  argsSchema: executeCodeArgsSchema,
  sideEffectLevel: 'none',
  mayMutateWorkspaceFiles: false,
  parallelBatchKind: 'ptc_cell',
  requiresApproval: false,
  async executeParsed(args: ExecuteCodeArgs, ctx) {
    if (!ctx.threadId || !ctx.projectId) {
      return toolError('execution_failed', 'run context is required for exec.');
    }
    const runtime = ctx.agentSpawnRuntime?.ptcExecuteCode;
    if (!runtime) {
      return toolError('execution_failed', 'PTC exec runtime is required.');
    }

    const callbackToolSurface = createPtcExecuteCodeToolCallbackSurface(ctx);
    const toolCallbackHandler = createPtcExecuteCodeToolCallbackHandler(
      ctx,
      callbackToolSurface,
    );
    const sdkHelp = createPtcExecuteCodeToolCallbackHelp(
      ctx,
      callbackToolSurface,
    );
    const runtimeArgs = {
      runContext: createRunWorkspaceContext({
        threadId: ctx.threadId,
        projectId: ctx.projectId,
        workspaceRoot: ctx.workspaceRoot,
      }),
      invocationId: ctx.callId,
      request: {
        code: args.code,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.yield_time_ms !== undefined
          ? { yieldTimeMs: args.yield_time_ms }
          : {}),
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
  if (summary.executionSurface === 'node_via_lab_detached_cell') {
    return JSON.stringify({
      kind: 'ptc_execute_code_cell_running',
      capabilityId: summary.capabilityId,
      policyId: summary.policyId,
      labPolicyId: summary.labPolicyId,
      profile: summary.profile,
      executionClass: summary.executionClass,
      executionSurface: summary.executionSurface,
      status: summary.status,
      cellId: summary.cellId,
      stdout: summary.stdout,
      stderr: summary.stderr,
      effectiveTimeoutMs: summary.effectiveTimeoutMs,
      durationMs: summary.durationMs,
      toolCallbacks: summary.toolCallbacks,
      sessionLifecycle: summary.sessionLifecycle,
      callbackHelp: summary.callbackHelp,
    });
  }
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
    'cellCloseStatus',
    'cellCloseMissing',
    'requestAborted',
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
    case 'ptc_execute_code_cell_busy':
    case 'ptc_execute_code_cell_result_unclaimed':
    case 'ptc_lab_session_busy':
      return 'conflict';
    case 'ptc_lab_interpreter_unavailable':
    case 'ptc_lab_session_unavailable':
    case 'ptc_lab_command_output_rejected':
    case 'ptc_lab_command_failed':
    case 'ptc_execute_code_session_cleanup_failed':
      return 'execution_failed';
  }
}
