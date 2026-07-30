import { isRunId } from '@geulbat/protocol/ids';
import { z } from 'zod';
import {
  PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_PYTHON_SDK_IMPORT_MODULE,
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
import type {
  AgentRuntimeAgentServices,
  AgentRuntimePtcServices,
  AgentRuntimeServices,
} from '../../daemon-runtime-contract.js';

// Exec needs the PTC exec runtime, the resource budget observer, and child
// provenance lookups — declare exactly that surface.
type ExecuteCodeToolServices = {
  agent: Pick<AgentRuntimeAgentServices, 'resourceBudgetProvider'>;
  childRuns: AgentRuntimeServices['childRuns'];
  ptc: Pick<AgentRuntimePtcServices, 'executeCode'>;
};

const executeCodeArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1, 'code is required.')
    .describe(
      'Code for PTC Docker. The default language is JavaScript with Node-native TypeScript syntax; Python runs with the standard library in the batch lane.',
    ),
  language: z
    .enum(['javascript', 'python'])
    .optional()
    .describe(
      `Omit or use "javascript" for JavaScript and Node-native TypeScript. Use "python" for Python standard-library batch execution with from ${PTC_EXECUTE_CODE_PYTHON_SDK_IMPORT_MODULE} import <tool_name> or geulbat.call_tool(name, args); Python does not accept moduleFormat or yield-time_ms.`,
    ),
  moduleFormat: z
    .enum(['commonjs', 'esm'])
    .optional()
    .describe(
      'JavaScript only. Omit for CommonJS require()/return; use "esm" for static import/export and top-level await. ESM writes results to stdout. npm packages resolve from this PTC session.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Optional timeout in milliseconds. Use the exact key timeoutMs; timeout_ms is not accepted. Omit to use the admitted PTC lab shell policy.',
    ),
  'yield-time_ms': z
    .number()
    .int()
    .min(PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS)
    .max(PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS)
    .optional()
    .describe(
      'JavaScript detached-cell only. Optional initial observation window in milliseconds. The key is exactly "yield-time_ms", with a hyphen; status "queued" or "running" continues through wait.',
    ),
  artifacts: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Files to export from /geulbat/artifacts after a successful batch execution. Use unique paths relative to that directory, for example ["reports/summary.json"]. Artifact bytes stay out of model history; the result returns durable evidence metadata and UI open/download links. Artifact export does not accept yield-time_ms and requires operator-configured limits.',
    ),
});

type ExecuteCodeArgs = z.output<typeof executeCodeArgsSchema>;

export const executeCodeTool = defineZodTool({
  name: PTC_EXECUTE_CODE_TOOL_NAME,
  description: `Run JavaScript, Node-native TypeScript, or Python in PTC Docker; use moduleFormat for JavaScript ESM. Python is standard-library batch execution: print the final value and prefer a generated wrapper such as from ${PTC_EXECUTE_CODE_PYTHON_SDK_IMPORT_MODULE} import read_file; geulbat.call_tool(name, args) and geulbat.tools.<tool_name>(args) remain available as low-level callbacks. Python does not accept moduleFormat or yield-time_ms. PTC has no direct host filesystem mount. Before a host callback, call geulbat.help() and require callbacks.enabled. When disabled, do not infer host inspection; report that operator callback transport policy is required. In JavaScript, use a generated CommonJS wrapper such as const { readFile } = require('geulbat-sdk/files/readFile'). Low-level geulbat.callTool returns raw { ok, output, errorCode?, error? }; Python geulbat.call_tool returns the same shape, not the generated wrapper's kind/value envelope. Generated wrappers return { kind: "inline", value: { ok: true, output: string } | { ok: false, output: string, errorCode: string, error: string } } or { kind: "offloaded", outputRef: string, ... }. Check result.kind and result.value.ok before result.value.output; wrapper values do not use status or content fields. For a batch, preserve each request path or name and report its errorCode and error rather than a generic message. For read_file/readFile, parse result.value.output and require payload.hasMore === false before treating payload.content as complete. Relative callback paths start from the user-selected run cwd; do not assume a repository cwd. To return a durable user file, write it below /geulbat/artifacts and list its relative path in artifacts; this runs to batch completion and returns metadata rather than file bytes. If exec returns status "queued" or status "running" with cellId, call wait with cell_id.`,
  argsSchema: executeCodeArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  parallelBatchKind: 'ptc_cell',
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'durable_handle',
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'runtime_summary',
    snapshotFailure: 'inline',
  },
  catalogSearchMetadata: {
    family: 'ptc',
    searchHints: [
      'execute code',
      'run code cell',
      'start ptc cell',
      'node code',
      'typescript code',
      'typescript enum code',
      'python code',
      'exec cell',
    ],
    tags: ['ptc', 'code', 'execution'],
    whenToUse:
      'Run JavaScript, Node-native TypeScript, or Python code in the PTC execution environment.',
    notFor: 'Generic shell commands or discovering tool names.',
  },
  async executeParsed(args: ExecuteCodeArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError('execution_failed', 'run context is required for exec.');
    }
    if (ctx.workingDirectory === undefined) {
      return toolError(
        'execution_failed',
        'Select a working folder before using exec.',
      );
    }
    const services: ExecuteCodeToolServices | undefined = ctx.runtimeServices;
    const runtime = services?.ptc.executeCode;
    if (!runtime) {
      return toolError('execution_failed', 'PTC exec runtime is required.');
    }
    const ownerKind = ctx.runOwnerKind ?? 'root_main';
    const childRun =
      ctx.kind === 'agent' && ownerKind === 'child' && isRunId(ctx.runId)
        ? services?.childRuns.getChildRun(ctx.runId)
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
    const sdkProjectionResult =
      args.language === 'python'
        ? ({ ok: true, projection: undefined } as const)
        : await resolvePtcExecuteCodeToolSdkProjection(
            ctx,
            callbackToolSurface,
          );
    if (!sdkProjectionResult.ok) {
      return toolError('execution_failed', sdkProjectionResult.message);
    }
    const resourceSnapshot =
      ctx.resourceSnapshotRef !== undefined || ctx.runState === undefined
        ? undefined
        : services?.agent.resourceBudgetProvider.captureSnapshot({
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
    const invocationRunId = ctx.runId ?? ctx.runState?.runId;
    const runtimeArgs = {
      runContext: {
        ...createRunContext({
          threadId: ctx.threadId,
          stateRoot: ctx.stateRoot,
          workingDirectory: ctx.workingDirectory,
        }),
        ownerKind,
      },
      ...(invocationRunId === undefined
        ? {}
        : { invocation: { runId: invocationRunId, callId: ctx.callId } }),
      invocationId: ctx.callId,
      request: {
        code: args.code,
        ...(args.language === undefined ? {} : { language: args.language }),
        ...(args.moduleFormat === undefined
          ? {}
          : { moduleFormat: args.moduleFormat }),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args['yield-time_ms'] !== undefined
          ? { yieldTimeMs: args['yield-time_ms'] }
          : {}),
        ...(args.artifacts === undefined
          ? {}
          : { artifacts: [...args.artifacts] }),
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
    ...(summary.language === undefined ? {} : { language: summary.language }),
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
    ...(summary.artifacts === undefined
      ? {}
      : { artifacts: summary.artifacts }),
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
    'artifactReasonCode',
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
    case 'ptc_execute_code_artifact_export_disabled':
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
    case 'ptc_execute_code_artifact_export_failed':
    case 'ptc_sdk_protocol_mismatch':
      return 'execution_failed';
  }
}
