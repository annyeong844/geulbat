import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessOutputSegment,
} from '../../shared/process-command.js';
import { sanitizePtcOutput } from '../../shared/output-redaction.js';
import type { PtcSessionEpochBridge } from '../../callback/session-epoch-bridge.js';
import type { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';
import type { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import type {
  PtcExecuteCodeCellRetainedResult,
  PtcExecuteCodeCellTerminalResult,
} from './execute-code-cell-terminal-retention.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeCellDurableOutput,
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeRuntimeCellWaitSummary,
  type PtcExecuteCodeRuntimeResult,
  type PtcExecuteCodeRuntimeStoreSummary,
  type PtcExecuteCodeRuntimeWaitResult,
} from './execute-code-runtime-contract.js';

type CreatePtcExecuteCodeCellRegistry = typeof createPtcExecuteCodeCellRegistry;

interface PtcExecuteCodeCallbackRuntimeSnapshot {
  enabled: boolean;
  toolCallbacksEnabled: boolean;
  observedCount(): number;
}

export function summarizeRunningCell(args: {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: PtcExecuteCodeCallbackRuntimeSnapshot;
  cellId: PtcExecuteCodeCellId;
  durationMs: number;
  effectiveTimeoutMs: number;
  output: DetachedProcessOutputSegment;
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
}): Extract<PtcExecuteCodeRuntimeResult, { ok: true }>['value'] {
  const output = sanitizeDetachedOutputSegment(args.output);
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    labPolicyId:
      args.admission.labPolicy?.policyId ?? args.admission.metadata.policyId,
    profile: 'lab',
    executionClass: 'lab_execute_code',
    executionSurface: 'node_via_lab_detached_cell',
    status: 'running',
    cellId: args.cellId,
    stdout: output.stdout,
    stderr: output.stderr,
    effectiveTimeoutMs: args.effectiveTimeoutMs,
    durationMs: args.durationMs,
    toolCallbacks: {
      enabled: args.callbackRuntime.toolCallbacksEnabled,
      observed: args.callbackRuntime.observedCount(),
    },
    sessionLifecycle: {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    },
    callbackHelp: {
      protocolVersion: args.sdkHelpBundle.protocolVersion,
      helpAvailable: true,
      callbackToolCount: args.sdkHelpBundle.callbacks.tools.length,
    },
  };
}

export function summarizeQueuedCell(args: {
  admission: PtcLabAdmittedProfile;
  callbackRuntime: PtcExecuteCodeCallbackRuntimeSnapshot;
  cellId: PtcExecuteCodeCellId;
  effectiveTimeoutMs: number;
  sdkHelpBundle: ReturnType<typeof buildPtcExecuteCodeSdkHelpBundle>;
}): Extract<PtcExecuteCodeRuntimeResult, { ok: true }>['value'] {
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    labPolicyId:
      args.admission.labPolicy?.policyId ?? args.admission.metadata.policyId,
    profile: 'lab',
    executionClass: 'lab_execute_code',
    executionSurface: 'node_via_lab_detached_cell',
    status: 'queued',
    cellId: args.cellId,
    stdout: '',
    stderr: '',
    effectiveTimeoutMs: args.effectiveTimeoutMs,
    durationMs: 0,
    toolCallbacks: {
      enabled: args.callbackRuntime.toolCallbacksEnabled,
      observed: args.callbackRuntime.observedCount(),
    },
    sessionLifecycle: {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    },
    callbackHelp: {
      protocolVersion: args.sdkHelpBundle.protocolVersion,
      helpAvailable: true,
      callbackToolCount: args.sdkHelpBundle.callbacks.tools.length,
    },
  };
}

export function summarizeWaitQueuedCell(
  cellId: PtcExecuteCodeCellId,
): Extract<PtcExecuteCodeRuntimeWaitResult, { ok: true }>['value'] {
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'queued',
    cellId,
    stdout: '',
    stderr: '',
  };
}

export function summarizeWaitRunningCell(args: {
  cellId: PtcExecuteCodeCellId;
  output: DetachedProcessOutputSegment;
}): Extract<PtcExecuteCodeRuntimeWaitResult, { ok: true }>['value'] {
  const output = sanitizeDetachedOutputSegment(args.output);
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'running',
    cellId: args.cellId,
    stdout: output.stdout,
    stderr: output.stderr,
  };
}

export function summarizeWaitRetainedCell(args: {
  cellId: PtcExecuteCodeCellId;
  result: PtcExecuteCodeCellRetainedResult;
}): PtcExecuteCodeRuntimeWaitResult {
  if (args.result.status === 'start_failed') {
    const failure = args.result.failure;
    return {
      ok: false,
      reasonCode: failure.reasonCode,
      message: failure.message,
      ...(failure.remediation === undefined
        ? {}
        : { remediation: failure.remediation }),
      ...(failure.diagnostics === undefined
        ? {}
        : { diagnostics: failure.diagnostics }),
      ...(failure.store === undefined ? {} : { store: failure.store }),
      ...(failure.storeError === undefined
        ? {}
        : { storeError: failure.storeError }),
    };
  }
  if (args.result.status === 'cleanup_failed') {
    if (args.result.terminalResult?.storeError !== undefined) {
      return storeCommitFailure({
        cellId: args.cellId,
        result: args.result.terminalResult,
        cleanupFailure: {
          message: args.result.message,
          diagnostics: args.result.diagnostics,
        },
      });
    }
    if (args.result.terminalResult?.exit.kind === 'output_limit_exceeded') {
      return cellOutputRejected({
        exit: args.result.terminalResult.exit,
        ...(args.result.terminalResult.store === undefined
          ? {}
          : { store: args.result.terminalResult.store }),
        cleanupFailure: {
          message: args.result.message,
          diagnostics: args.result.diagnostics,
        },
      });
    }
    if (args.result.terminalResult?.exit.kind === 'timeout') {
      return cellTimedOut({
        ...(args.result.terminalResult.store === undefined
          ? {}
          : { store: args.result.terminalResult.store }),
        cleanupFailure: {
          message: args.result.message,
          diagnostics: args.result.diagnostics,
        },
      });
    }
    if (args.result.terminalResult !== undefined) {
      return {
        ok: true,
        value: summarizeWaitTerminalCell({
          cellId: args.cellId,
          result: args.result.terminalResult,
          cleanupFailure: {
            message: args.result.message,
            diagnostics: args.result.diagnostics,
          },
        }),
      };
    }
    return cellCleanupFailure({
      message: args.result.message,
      diagnostics: args.result.diagnostics,
    });
  }
  if (args.result.storeError !== undefined) {
    return storeCommitFailure({ cellId: args.cellId, result: args.result });
  }
  if (args.result.exit.kind === 'output_limit_exceeded') {
    return cellOutputRejected({
      exit: args.result.exit,
      ...(args.result.store === undefined ? {} : { store: args.result.store }),
    });
  }
  if (args.result.exit.kind === 'timeout') {
    return cellTimedOut({
      ...(args.result.store === undefined ? {} : { store: args.result.store }),
    });
  }
  return {
    ok: true,
    value: summarizeWaitTerminalCell({
      cellId: args.cellId,
      result: args.result,
    }),
  };
}

export function summarizeWaitDurableCell(args: {
  cellId: PtcExecuteCodeCellId;
  durableOutput: PtcExecuteCodeCellDurableOutput;
}): PtcExecuteCodeRuntimeCellWaitSummary {
  const exitCode = args.durableOutput.exitCode;
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    cellId: args.cellId,
    ...args.durableOutput,
    offloaded: true,
    recoveryTool: 'read_tool_output',
    summary: `wait observed cell ${args.cellId} with status ${args.durableOutput.status}${typeof exitCode === 'number' ? ` and exit code ${String(exitCode)}` : ''}. Exact output is available through read_tool_output with explicit offset and limit.`,
  };
}

function cellTimedOut(
  args: {
    cleanupFailure?: {
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };
    store?: PtcExecuteCodeRuntimeStoreSummary;
  } = {},
): PtcExecuteCodeRuntimeWaitResult {
  return {
    ok: false,
    reasonCode: 'ptc_lab_command_timeout',
    message: 'PTC execute_code cell timed out',
    ...(args.store !== undefined && 'discardedWrites' in args.store
      ? { store: args.store }
      : {}),
    diagnostics:
      args.cleanupFailure === undefined
        ? { cellExitKind: 'timeout' }
        : {
            cellExitKind: 'timeout',
            cleanupFailureMessage: args.cleanupFailure.message,
            ...args.cleanupFailure.diagnostics,
          },
  };
}

function cellOutputRejected(args: {
  exit: Extract<DetachedProcessExitInfo, { kind: 'output_limit_exceeded' }>;
  cleanupFailure?: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
  store?: PtcExecuteCodeRuntimeStoreSummary;
}): PtcExecuteCodeRuntimeWaitResult {
  return {
    ok: false,
    reasonCode: 'ptc_lab_command_output_rejected',
    message: 'PTC execute_code cell output exceeded the policy buffer budget',
    ...(args.store !== undefined && 'discardedWrites' in args.store
      ? { store: args.store }
      : {}),
    diagnostics: {
      outputStream: args.exit.stream,
      maxBufferedBytesPerStream: args.exit.maxBufferedBytesPerStream,
      ...(args.cleanupFailure === undefined
        ? {}
        : {
            cleanupFailureMessage: args.cleanupFailure.message,
            ...args.cleanupFailure.diagnostics,
          }),
    },
  };
}

function summarizeWaitTerminalCell(args: {
  cellId: PtcExecuteCodeCellId;
  result: PtcExecuteCodeCellTerminalResult;
  cleanupFailure?: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
}): Extract<PtcExecuteCodeRuntimeWaitResult, { ok: true }>['value'] {
  const output = sanitizeDetachedOutputSegment(args.result.output);
  const baseSummary = {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    cellId: args.cellId,
    exitCode: args.result.exit.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    ...(args.result.store === undefined ? {} : { store: args.result.store }),
  } as const;
  if (args.cleanupFailure === undefined) {
    return {
      ...baseSummary,
      status: args.result.status,
    };
  }
  return {
    ...baseSummary,
    status:
      args.result.status === 'completed'
        ? 'completed_with_cleanup_failure'
        : 'terminated_with_cleanup_failure',
    cleanupFailure: args.cleanupFailure,
  };
}

export function summarizeWaitClosedCell(args: {
  cellId: PtcExecuteCodeCellId;
  output: DetachedProcessOutputSegment | undefined;
  exit: DetachedProcessExitInfo | undefined;
  store?: PtcExecuteCodeRuntimeStoreSummary;
}): Extract<PtcExecuteCodeRuntimeWaitResult, { ok: true }>['value'] {
  return summarizeWaitTerminalCell({
    cellId: args.cellId,
    result: {
      status: 'terminated',
      output: args.output ?? emptyDetachedOutputSegment(),
      exit:
        args.exit ??
        ({ kind: 'signal', exitCode: null, processTerminated: false } as const),
      ...(args.store === undefined ? {} : { store: args.store }),
    },
  });
}

export function summarizeWaitMissingCell(
  cellId: PtcExecuteCodeCellId,
): Extract<PtcExecuteCodeRuntimeWaitResult, { ok: true }>['value'] {
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'missing',
    cellId,
    remediation: 'start_a_new_exec',
  };
}

export function summarizeWaitExpiredCell(
  cellId: PtcExecuteCodeCellId,
): Extract<PtcExecuteCodeRuntimeWaitResult, { ok: true }>['value'] {
  return {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'expired',
    cellId,
    remediation: 'start_a_new_exec',
  };
}

type PtcExecuteCodeCellCloseResult = Awaited<
  ReturnType<ReturnType<CreatePtcExecuteCodeCellRegistry>['closeCell']>
>;

export function isProvenTerminatedCellCleanup(
  result: PtcExecuteCodeCellCloseResult,
): boolean {
  return (
    result.ok &&
    result.status === 'terminated' &&
    result.bridgeClosed === true &&
    result.sessionTainted === true &&
    result.cleanupDiagnostics === undefined
  );
}

export function cellCleanupFailure(args: {
  message: string;
  diagnostics: Record<string, string | number | boolean>;
  store?: PtcExecuteCodeRuntimeStoreSummary;
}): {
  ok: false;
  reasonCode: 'ptc_execute_code_session_cleanup_failed';
  message: string;
  diagnostics: Record<string, string | number | boolean>;
  store?: Extract<
    PtcExecuteCodeRuntimeStoreSummary,
    { discardedWrites: number }
  >;
} {
  return {
    ok: false,
    reasonCode: 'ptc_execute_code_session_cleanup_failed',
    message: args.message,
    diagnostics: args.diagnostics,
    ...(args.store !== undefined && 'discardedWrites' in args.store
      ? { store: args.store }
      : {}),
  };
}

function storeCommitFailure(args: {
  cellId: PtcExecuteCodeCellId;
  result: PtcExecuteCodeCellTerminalResult;
  cleanupFailure?: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
}): PtcExecuteCodeRuntimeWaitResult {
  const storeError = args.result.storeError;
  if (storeError === undefined) {
    throw new Error('expected detached-cell store commit failure');
  }
  return {
    ok: false,
    reasonCode:
      storeError.errorCode === 'StoreCommitConflict'
        ? 'ptc_execute_code_store_commit_conflict'
        : 'ptc_execute_code_store_commit_failed',
    message: storeError.message,
    storeError,
    ...(args.result.store !== undefined &&
    'discardedWrites' in args.result.store
      ? { store: args.result.store }
      : {}),
    diagnostics: {
      cellId: args.cellId,
      ...(args.cleanupFailure === undefined
        ? {}
        : {
            cleanupFailureMessage: args.cleanupFailure.message,
            ...args.cleanupFailure.diagnostics,
          }),
    },
  };
}

export function cellCloseDiagnostics(
  result: PtcExecuteCodeCellCloseResult,
): Record<string, string | number | boolean> {
  if (!result.ok) {
    return { cellCloseMissing: true };
  }
  if (result.status !== 'terminated') {
    return { cellCloseStatus: result.status };
  }
  return {
    cellCloseStatus: result.status,
    ...(result.bridgeClosed === false
      ? { callbackBridgeCloseFailed: true }
      : {}),
    ...(result.sessionTainted === false
      ? { sessionCloseFailed: true, sessionTainted: true }
      : {}),
    ...(result.cleanupDiagnostics ?? {}),
  };
}

export function sanitizeDetachedOutputSegment(
  output: DetachedProcessOutputSegment,
): {
  stdout: string;
  stderr: string;
} {
  const stdout = sanitizePtcOutput(output.stdout);
  const stderr = sanitizePtcOutput(output.stderr);
  return {
    stdout,
    stderr,
  };
}

export function sensitiveBridgeMarkers(
  bridge: PtcSessionEpochBridge | undefined,
): string[] {
  return bridge === undefined
    ? []
    : [
        bridge.token,
        bridge.callbackSocketContainerPath,
        bridge.callbackSocketHostPath,
      ];
}

export function validateCellId(
  cellId: string,
): PtcExecuteCodeCellId | undefined {
  const suffix = /^ptc_cell_([A-Za-z0-9_.:-]+)$/u.exec(cellId)?.[1];
  return suffix === undefined ? undefined : `ptc_cell_${suffix}`;
}

function emptyDetachedOutputSegment(): DetachedProcessOutputSegment {
  return {
    stdout: '',
    stderr: '',
  };
}
