import { isRunId } from '@geulbat/protocol/ids';
import { z } from 'zod';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodePlacementContinuityProvenance,
  type PtcExecuteCodePlacementResourceSnapshotRef,
  type PtcExecuteCodeRuntimeFailureReason,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeSummary,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { createRunContext } from '../../run-context.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  createPtcExecuteCodeCallbackBreakdown,
  createPtcExecuteCodeToolCallbackHandler,
  createPtcExecuteCodeToolCallbackHelp,
  createPtcExecuteCodeToolCallbackSurface,
  resolvePtcExecuteCodeToolSdkProjection,
  type PtcExecuteCodeCallbackBreakdown,
} from './execute-code-tool-callback.js';

const executeCodeArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1, 'code is required.')
    .describe(
      'JavaScript or erasable TypeScript code to run inside the PTC lab Docker runtime. Type annotations, interfaces, and type aliases are supported; TSX and TypeScript syntax that requires transformation (such as enums, runtime namespaces, parameter properties, or decorators) are not. Use stdout or return a JSON-serializable value for compact results.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Optional execution timeout in milliseconds. Use the exact key timeoutMs; timeout_ms is not accepted. Omitted requests use the admitted PTC lab shell policy.',
    ),
  'yield-time_ms': z
    .number()
    .int()
    .min(PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS)
    .max(PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS)
    .optional()
    .describe(
      'Optional initial observation window in milliseconds for detached exec cells. The JSON property name is exactly "yield-time_ms", with a hyphen between "yield" and "time". If exec returns status "queued" or "running", call wait with the returned cellId.',
    ),
});

type ExecuteCodeArgs = z.output<typeof executeCodeArgsSchema>;

export const executeCodeTool = defineZodTool({
  name: PTC_EXECUTE_CODE_TOOL_NAME,
  description:
    'Run JavaScript or erasable TypeScript code inside the PTC lab Docker runtime. Type annotations, interfaces, and type aliases work without transpilation; TSX and TypeScript syntax that requires transformation do not. Prefer the pinned generated geulbat-sdk wrappers discovered from the tool library, such as require(\'geulbat-sdk/files/readFile\') or require(\'geulbat-sdk/tools/search-memory-index\'); geulbat.callTool(name, args) remains the admitted low-level bridge. If the result has status "queued" or status "running" and a cellId, call wait with cell_id set to that cellId to observe admission, completion, or termination.',
  argsSchema: executeCodeArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  parallelBatchKind: 'ptc_cell',
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'ptc',
    searchHints: [
      'execute code',
      'run code cell',
      'start ptc cell',
      'node code',
      'typescript code',
      'exec cell',
    ],
    tags: ['ptc', 'code', 'execution'],
    whenToUse:
      'Run JavaScript or erasable TypeScript code in the PTC execution environment.',
    notFor: 'Generic shell commands or discovering tool names.',
  },
  async executeParsed(args: ExecuteCodeArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError('execution_failed', 'run context is required for exec.');
    }
    const runtime = ctx.agentSpawnRuntime?.ptcExecuteCode;
    if (!runtime) {
      return toolError('execution_failed', 'PTC exec runtime is required.');
    }
    const ownerKind = ctx.runOwnerKind ?? 'root_main';
    const childRun =
      ctx.kind === 'agent' && ownerKind === 'child' && isRunId(ctx.runId)
        ? ctx.agentSpawnRuntime?.childRuns.getChildRun(ctx.runId)
        : undefined;
    const placementContinuityProvenance:
      | PtcExecuteCodePlacementContinuityProvenance
      | undefined =
      childRun?.subagentType === 'explorer'
        ? { independenceProof: { reason: 'read_only_analysis' } }
        : undefined;

    const callbackToolSurface = createPtcExecuteCodeToolCallbackSurface(ctx);
    const callbackBreakdown =
      callbackToolSurface?.writeTierEnabled === true
        ? createPtcExecuteCodeCallbackBreakdown()
        : undefined;
    const toolCallbackHandler = createPtcExecuteCodeToolCallbackHandler(
      ctx,
      callbackToolSurface,
      callbackBreakdown,
    );
    const sdkHelp = createPtcExecuteCodeToolCallbackHelp(
      ctx,
      callbackToolSurface,
    );
    const sdkProjectionResult = await resolvePtcExecuteCodeToolSdkProjection(
      ctx,
      callbackToolSurface,
    );
    if (!sdkProjectionResult.ok) {
      return toolError('execution_failed', sdkProjectionResult.message);
    }
    const resourceSnapshot =
      ctx.resourceSnapshotRef !== undefined || ctx.runState === undefined
        ? undefined
        : ctx.agentSpawnRuntime?.resourceBudgetProvider.captureSnapshot({
            runState: ctx.runState,
          });
    const placementResourceSnapshotId =
      ctx.resourceSnapshotRef?.snapshotId ?? resourceSnapshot?.snapshotId;
    const placementResourceSnapshotRef:
      | PtcExecuteCodePlacementResourceSnapshotRef
      | undefined =
      placementResourceSnapshotId === undefined
        ? undefined
        : {
            snapshotId: placementResourceSnapshotId,
            source: 'agent_resource_budget_provider',
          };
    const runtimeArgs = {
      runContext: {
        ...createRunContext({
          threadId: ctx.threadId,
          stateRoot: ctx.stateRoot,
          workingDirectory: ctx.workingDirectory ?? '',
        }),
        ownerKind,
      },
      invocationId: ctx.callId,
      request: {
        code: args.code,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args['yield-time_ms'] !== undefined
          ? { yieldTimeMs: args['yield-time_ms'] }
          : {}),
      },
      ...(placementResourceSnapshotRef === undefined
        ? {}
        : { placementResourceSnapshotRef }),
      ...(placementContinuityProvenance === undefined
        ? {}
        : { placementContinuityProvenance }),
      ...(sdkHelp ? { sdkHelp } : {}),
      ...(sdkProjectionResult.projection === undefined
        ? {}
        : { sdkProjection: sdkProjectionResult.projection }),
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
      output: stringifyExecuteCodeSummary(result.value, callbackBreakdown),
    };
  },
});

function stringifyExecuteCodeSummary(
  summary: PtcExecuteCodeRuntimeSummary,
  callbackBreakdown?: PtcExecuteCodeCallbackBreakdown,
): string {
  // Present only when the write-callback tier is enabled: the default surface
  // stays byte-identical without the knob.
  const breakdownField =
    callbackBreakdown === undefined
      ? {}
      : { toolCallbackBreakdown: callbackBreakdown };
  if (summary.executionSurface === 'node_via_lab_detached_cell') {
    return JSON.stringify({
      kind:
        summary.status === 'queued'
          ? 'ptc_execute_code_cell_queued'
          : 'ptc_execute_code_cell_running',
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
      ...breakdownField,
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
    ...breakdownField,
    sessionLifecycle: summary.sessionLifecycle,
    callbackHelp: summary.callbackHelp,
    ...(summary.store === undefined ? {} : { store: summary.store }),
  });
}

function stringifyExecuteCodeFailure(
  failure: Extract<PtcExecuteCodeRuntimeResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: 'ptc_execute_code_error',
    reasonCode: failure.reasonCode,
    message: failure.message,
    ...(failure.remediation === undefined
      ? {}
      : { remediation: failure.remediation }),
    diagnostics: sanitizeFailureDiagnostics(failure.diagnostics),
    ...(failure.store === undefined ? {} : { store: failure.store }),
    ...(failure.storeError === undefined
      ? {}
      : { storeError: failure.storeError }),
    ...(failure.execution === undefined
      ? {}
      : { execution: failure.execution }),
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
    'expectedProtocolVersion',
    'receivedProtocolVersion',
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
    case 'ptc_execute_code_store_commit_conflict':
    case 'ptc_lab_session_busy':
      return 'conflict';
    case 'ptc_lab_interpreter_unavailable':
    case 'ptc_lab_session_unavailable':
    case 'ptc_lab_command_output_rejected':
    case 'ptc_lab_command_failed':
    case 'ptc_execute_code_session_cleanup_failed':
    case 'ptc_execute_code_store_unavailable':
    case 'ptc_execute_code_store_commit_failed':
    case 'ptc_sdk_protocol_mismatch':
      return 'execution_failed';
  }
}
