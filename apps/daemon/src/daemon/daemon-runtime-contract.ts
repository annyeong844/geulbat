import type { ProjectId, RunId, ThreadId } from '@geulbat/protocol/ids';
import type { ProviderAuthRuntimeStore } from './auth/runtime-state.js';
import type { ProviderRequestOptions } from './llm/provider/provider-options.js';
import type { ResponsesWebSocketSessionStore } from './llm/provider/transport/responses-websocket-cache.js';
import type { ActiveRunStore } from './sessions/active-runs.js';
import type { SandboxAttemptStore } from './sandbox/attempt-store.js';
import type { ApprovalGrantStore } from './tools/approval-grants.js';
import type { ToolRuntimeRegistry } from './tools/tool-registry-model.js';
import type { MemoryIndexStore } from './memory/build-index.js';
import type { FileStateCache } from './utils/file-state-cache.js';
import type { ChildRunRegistry } from './agent/runtime/child-run-registry.js';
import type { ApprovalGate } from './agent/runtime/approval-gate.js';
import type { SubagentAdmissionController } from './agent/subagent-concurrency.js';
import type {
  BackgroundChildResult,
  SubagentLaunchReservation,
  SubagentType,
} from './subagent-runtime-contracts.js';
import type { AgentEvent, ToolRunState } from './runtime-contracts.js';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunWorkspaceContext } from './run-workspace-context.js';
import type { PtcFixedEpochProbeRuntimeResult } from './ptc/fixed-probe-runtime-contract.js';
import type { PtcLabSessionBatchCommandFailureReason } from './ptc/lab-session-batch-command-contract.js';
import type { PtcBrowserNavigateRuntime } from './ptc/browser-navigate-runtime-contract.js';
import {
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  type PtcExecuteCodeRuntimeSdkHelp,
  type PtcExecuteCodeRuntimeToolCallbackHandler,
} from './ptc/execute-code-runtime-contract.js';

export {
  PTC_BROWSER_NAVIGATE_LAB_POLICY_ID,
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
  PTC_BROWSER_NAVIGATE_MAX_URL_BYTES,
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
  PTC_BROWSER_NAVIGATE_TOOL_TIMEOUT_MS,
  PTC_BROWSER_NAVIGATE_TRUST_CONTEXT_ID,
} from './ptc/browser-navigate-runtime-contract.js';
export type {
  PtcBrowserNavigateFailureReason,
  PtcBrowserNavigateRuntime,
  PtcBrowserNavigateRuntimeCleanupResult,
  PtcBrowserNavigateRuntimeError,
  PtcBrowserNavigateRuntimeRequest,
  PtcBrowserNavigateRuntimeResult,
  PtcBrowserNavigateRuntimeSummary,
} from './ptc/browser-navigate-runtime-contract.js';
export { PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION };
export type {
  PtcExecuteCodeRuntimeSdkHelp,
  PtcExecuteCodeRuntimeSdkHelpTool,
  PtcExecuteCodeRuntimeToolCallbackHandler,
  PtcExecuteCodeRuntimeToolCallbackResult,
  PtcExecuteCodeRuntimeToolParameters,
} from './ptc/execute-code-runtime-contract.js';

export type AgentMemoryIndex = Pick<
  MemoryIndexStore,
  'refreshMemoryIndex' | 'computeCurrentSourceSnapshot' | 'loadMemoryIndex'
>;

export interface StartSubagentBackgroundRunArgs {
  task: string;
  subagentType: SubagentType;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  projectId: ProjectId;
  workspaceRoot: string;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation?: SubagentLaunchReservation;
  approvalSessionId?: string;
  permissionMode?: PermissionMode;
  emitAgentEvent?: (event: AgentEvent) => void;
  timeoutMs?: number;
  childRunId?: RunId;
  childThreadId?: ThreadId;
}

export interface SubagentRunLauncher {
  startBackgroundRun(args: StartSubagentBackgroundRunArgs): Promise<{
    ok: true;
    output: string;
  }>;
}

export const PTC_EXECUTE_CODE_TOOL_NAME = 'execute_code' as const;
export const PTC_EXECUTE_CODE_POLICY_ID =
  'ptc_lab_execute_code_batch_node_v1' as const;
export const PTC_EXECUTE_CODE_MAX_CODE_BYTES = 20 * 1024;
export const PTC_EXECUTE_CODE_DEFAULT_TIMEOUT_MS = 60_000;
export const PTC_EXECUTE_CODE_MAX_TIMEOUT_MS = 300_000;

export interface PtcFixedEpochProbeRuntime {
  runFixedEpochProbe(args: {
    runContext: RunWorkspaceContext;
    signal?: AbortSignal;
  }): Promise<PtcFixedEpochProbeRuntimeResult>;
}

export type PtcExecuteCodeRuntimeFailureReason =
  | 'ptc_execute_code_invalid'
  | 'ptc_execute_code_callback_bridge_unavailable'
  | 'ptc_execute_code_lab_admission_failed'
  | 'ptc_execute_code_session_cleanup_failed'
  | PtcLabSessionBatchCommandFailureReason;

export interface PtcExecuteCodeRuntimeRequest {
  code: string;
  timeoutMs?: number;
}

export interface PtcExecuteCodeRuntimeSummary {
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
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
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
}

export type PtcExecuteCodeRuntimeResult =
  | { ok: true; value: PtcExecuteCodeRuntimeSummary }
  | {
      ok: false;
      reasonCode: PtcExecuteCodeRuntimeFailureReason;
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
    runContext: RunWorkspaceContext;
    request: PtcExecuteCodeRuntimeRequest;
    sdkHelp?: PtcExecuteCodeRuntimeSdkHelp;
    toolCallbackHandler?: PtcExecuteCodeRuntimeToolCallbackHandler;
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeResult>;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeCleanupResult>;
}

export interface AgentRuntimeServices {
  activeRuns: Pick<
    ActiveRunStore,
    'abortTrackedRun' | 'finishRun' | 'tryStartRun'
  >;
  approvalGrants: ApprovalGrantStore;
  approvalGate: Pick<ApprovalGate, 'waitForApproval'>;
  backgroundNotifications: {
    enqueueThreadBackgroundResult(
      threadId: ThreadId,
      result: BackgroundChildResult,
    ): void;
    consumeThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
  };
  childRuns: ChildRunRegistry;
  fileStateCache: FileStateCache;
  memoryIndex: AgentMemoryIndex;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
  ptcBrowserNavigate: PtcBrowserNavigateRuntime;
  ptcExecuteCode: PtcExecuteCodeRuntime;
  ptcFixedProbe: PtcFixedEpochProbeRuntime;
  sandboxAttempts: SandboxAttemptStore;
  subagentAdmission: SubagentAdmissionController;
  subagentRuns: SubagentRunLauncher;
  toolRegistry: ToolRuntimeRegistry;
}
