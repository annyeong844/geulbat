import type { PtcLabSessionBatchCommandFailureReason } from '../../shared/lab-batch-command-contract.js';

export const PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION =
  'ptc_execute_code_sdk_v1' as const;
export const PTC_EXECUTE_CODE_TOOL_NAME = 'exec' as const;
// Temporary tombstone; see the L2b code-mode contract before deleting.
export const PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME = 'execute_code' as const;
export const PTC_EXECUTE_CODE_WAIT_TOOL_NAME = 'wait' as const;
export const PTC_EXECUTE_CODE_POLICY_ID =
  'ptc_lab_execute_code_batch_node_v1' as const;
export const PTC_EXECUTE_CODE_TRUST_CONTEXT_ID = PTC_EXECUTE_CODE_POLICY_ID;
export const PTC_EXECUTE_CODE_CELL_EXEC_MIN_YIELD_MS = 1_000;
export const PTC_EXECUTE_CODE_CELL_EXEC_MAX_YIELD_MS = 60_000;
export const PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS = 1_000;
export const PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS = 300_000;
export type PtcExecuteCodeCellId = `ptc_cell_${string}`;

export interface PtcExecuteCodeRuntimeToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface PtcExecuteCodeRuntimeToolOneOfParameters {
  oneOf: PtcExecuteCodeRuntimeToolParameters[];
}

export interface PtcExecuteCodeRuntimeToolAnyOfParameters {
  anyOf: PtcExecuteCodeRuntimeToolParameters[];
}

export type PtcExecuteCodeRuntimeSdkHelpToolParameters =
  | PtcExecuteCodeRuntimeToolParameters
  | PtcExecuteCodeRuntimeToolOneOfParameters
  | PtcExecuteCodeRuntimeToolAnyOfParameters;

export interface PtcExecuteCodeRuntimeSdkHelpTool {
  name: string;
  description: string;
  parameters: PtcExecuteCodeRuntimeSdkHelpToolParameters;
}

export interface PtcExecuteCodeRuntimeSdkHelp {
  callbackTools: readonly PtcExecuteCodeRuntimeSdkHelpTool[];
}

type PtcExecuteCodeRuntimeToolCallbackResult =
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; message: string };

export type PtcExecuteCodeRuntimeToolCallbackHandler = (invocation: {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  cellId?: string;
  signal: AbortSignal;
  enterLongWait?: () => boolean;
}) => Promise<PtcExecuteCodeRuntimeToolCallbackResult>;

export type PtcExecuteCodeRuntimeFailureReason =
  | 'ptc_execute_code_invalid'
  | 'ptc_execute_code_cell_busy'
  | 'ptc_execute_code_cell_result_unclaimed'
  | 'ptc_execute_code_callback_bridge_unavailable'
  | 'ptc_execute_code_lab_admission_failed'
  | 'ptc_execute_code_session_cleanup_failed'
  | PtcLabSessionBatchCommandFailureReason;

interface PtcExecuteCodeRuntimeRequest {
  code: string;
  timeoutMs?: number;
  yieldTimeMs?: number;
}

interface PtcExecuteCodeRuntimeCompletedSummary {
  ok: true;
  capabilityId: typeof PTC_EXECUTE_CODE_TOOL_NAME;
  policyId: typeof PTC_EXECUTE_CODE_POLICY_ID;
  labPolicyId: string;
  profile: 'lab';
  executionClass: 'lab_execute_code';
  executionSurface: 'node_via_lab_batch_command';
  exitCode: number;
  stdout: string;
  stderr: string;
  effectiveTimeoutMs: number;
  durationMs: number;
  toolCallbacks: {
    enabled: boolean;
    observed: number;
  };
  sessionLifecycle: {
    mode: 'runtime_owned_reusable';
    retainedAfterExecution: boolean;
  };
  callbackHelp: {
    protocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
    helpAvailable: boolean;
    callbackToolCount: number;
  };
  cleanupFailure?: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
}

interface PtcExecuteCodeRuntimeCellRunningSummary {
  ok: true;
  capabilityId: typeof PTC_EXECUTE_CODE_TOOL_NAME;
  policyId: typeof PTC_EXECUTE_CODE_POLICY_ID;
  labPolicyId: string;
  profile: 'lab';
  executionClass: 'lab_execute_code';
  executionSurface: 'node_via_lab_detached_cell';
  status: 'running';
  cellId: PtcExecuteCodeCellId;
  stdout: string;
  stderr: string;
  effectiveTimeoutMs: number;
  durationMs: number;
  toolCallbacks: {
    enabled: boolean;
    observed: number;
  };
  sessionLifecycle: {
    mode: 'runtime_owned_reusable';
    retainedAfterExecution: true;
  };
  callbackHelp: {
    protocolVersion: typeof PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
    helpAvailable: boolean;
    callbackToolCount: number;
  };
}

export type PtcExecuteCodeRuntimeSummary =
  | PtcExecuteCodeRuntimeCompletedSummary
  | PtcExecuteCodeRuntimeCellRunningSummary;

interface PtcExecuteCodeRuntimeCellWaitBaseSummary {
  ok: true;
  capabilityId: typeof PTC_EXECUTE_CODE_TOOL_NAME;
  policyId: typeof PTC_EXECUTE_CODE_POLICY_ID;
  executionSurface: 'node_via_lab_detached_cell';
  cellId: PtcExecuteCodeCellId;
}

interface PtcExecuteCodeRuntimeCellWaitRunningSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'running';
  stdout: string;
  stderr: string;
}

interface PtcExecuteCodeRuntimeCellWaitTerminalSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'completed' | 'terminated';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface PtcExecuteCodeRuntimeCellWaitTerminalCleanupFailureSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'completed_with_cleanup_failure' | 'terminated_with_cleanup_failure';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cleanupFailure: {
    message: string;
    diagnostics: Record<string, string | number | boolean>;
  };
}

interface PtcExecuteCodeRuntimeCellWaitMissingSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'missing';
  remediation: 'start_a_new_exec';
}

interface PtcExecuteCodeRuntimeCellWaitExpiredSummary extends PtcExecuteCodeRuntimeCellWaitBaseSummary {
  status: 'expired';
  remediation: 'start_a_new_exec';
}

export type PtcExecuteCodeRuntimeCellWaitSummary =
  | PtcExecuteCodeRuntimeCellWaitRunningSummary
  | PtcExecuteCodeRuntimeCellWaitTerminalSummary
  | PtcExecuteCodeRuntimeCellWaitTerminalCleanupFailureSummary
  | PtcExecuteCodeRuntimeCellWaitMissingSummary
  | PtcExecuteCodeRuntimeCellWaitExpiredSummary;

export type PtcExecuteCodeRuntimeResult =
  | { ok: true; value: PtcExecuteCodeRuntimeSummary }
  | {
      ok: false;
      reasonCode: PtcExecuteCodeRuntimeFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export type PtcExecuteCodeRuntimeWaitFailureReason =
  | 'ptc_execute_code_invalid'
  | 'ptc_execute_code_cell_wait_unavailable'
  | 'ptc_execute_code_cell_wait_cancelled'
  | 'ptc_lab_command_timeout'
  | 'ptc_lab_command_output_rejected'
  | 'ptc_execute_code_session_cleanup_failed';

export type PtcExecuteCodeRuntimeWaitResult =
  | { ok: true; value: PtcExecuteCodeRuntimeCellWaitSummary }
  | {
      ok: false;
      reasonCode: PtcExecuteCodeRuntimeWaitFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export type PtcExecuteCodeRuntimeCleanupResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: 'ptc_execute_code_session_cleanup_failed';
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcExecuteCodeRuntime {
  executeCode(args: {
    runContext: {
      threadId: string;
      projectId: string;
      workspaceRoot: string;
    };
    invocationId?: string;
    request: PtcExecuteCodeRuntimeRequest;
    sdkHelp?: PtcExecuteCodeRuntimeSdkHelp;
    toolCallbackHandler?: PtcExecuteCodeRuntimeToolCallbackHandler;
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeResult>;
  waitForCell(args: {
    runContext: {
      threadId: string;
    };
    request: {
      cellId: string;
      terminate?: boolean;
      yieldTimeMs?: number;
    };
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeWaitResult>;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeCleanupResult>;
}
