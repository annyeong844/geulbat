import type { ProjectId, RunId, ThreadId } from '@geulbat/protocol/ids';
import type { ProviderAuthRuntimeStore } from './auth/runtime-state.js';
import type { ProviderRequestOptions } from './llm/provider/provider-options.js';
import type { ReactBundleStructuredOutputIngressPolicy } from './agent/react-bundle-structured-output-ingress-policy.js';
import type { ResponsesWebSocketSessionStore } from './llm/provider/transport/responses-websocket-cache.js';
import type { ActiveRunStore } from './sessions/active-runs.js';
import type { SandboxAttemptStore } from './sandbox/attempt-store.js';
import type { ApprovalGrantStore } from './tools/approval-grants.js';
import type { ToolRuntimeRegistry } from './tools/tool-registry-model.js';
import type { MemoryIndexStore } from './memory/build-index.js';
import type { FileStateCache } from './utils/file-state-cache.js';
import type { ChildRunRegistry } from './agent/runtime/child-run-registry.js';
import type { ApprovalGate } from './agent/runtime/approval-gate.js';
import type { AgentWorkflowRunner } from './agent/agent-workflow-runner.js';
import type { AgentWavePlanner } from './agent/agent-wave-planner.js';
import type { ResourceBudgetProvider } from './agent/resource-budget-provider.js';
import type { SubagentAdmissionController } from './agent/subagent-concurrency.js';
import type {
  BackgroundChildResult,
  SubagentLaunchReservation,
  SubagentType,
} from './subagent-runtime-contracts.js';
import type { AgentEvent, ToolRunState } from './runtime-contracts.js';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunWorkspaceContext } from './run-workspace-context.js';
import type { PtcFixedEpochProbeRuntimeResult } from './ptc/runtime/probes/fixed-probe-runtime-contract.js';
import type { PtcBrowserPageLoadEvidenceRuntime } from './ptc/runtime/browser/browser-page-load-evidence-runtime-contract.js';
import type { PtcBrowserTextEvidenceRuntime } from './ptc/runtime/browser/browser-text-evidence-runtime-contract.js';
import type { PtcBrowserNavigateRuntime } from './ptc/runtime/browser/browser-navigate-runtime-contract.js';
import type { PtcExecuteCodeRuntime } from './ptc/runtime/execute-code/execute-code-runtime-contract.js';

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

export interface PtcFixedEpochProbeRuntime {
  runFixedEpochProbe(args: {
    runContext: RunWorkspaceContext;
    signal?: AbortSignal;
  }): Promise<PtcFixedEpochProbeRuntimeResult>;
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
  agentWorkflowRunner: AgentWorkflowRunner;
  agentWavePlanner: AgentWavePlanner;
  memoryIndex: AgentMemoryIndex;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
  reactBundleStructuredOutputIngressPolicy: ReactBundleStructuredOutputIngressPolicy;
  resourceBudgetProvider: ResourceBudgetProvider;
  ptcBrowserPageLoadEvidence: PtcBrowserPageLoadEvidenceRuntime;
  ptcBrowserTextEvidence: PtcBrowserTextEvidenceRuntime;
  ptcBrowserNavigate: PtcBrowserNavigateRuntime;
  ptcExecuteCode: PtcExecuteCodeRuntime;
  ptcFixedProbe: PtcFixedEpochProbeRuntime;
  sandboxAttempts: SandboxAttemptStore;
  subagentAdmission: SubagentAdmissionController;
  subagentRuns: SubagentRunLauncher;
  toolRegistry: ToolRuntimeRegistry;
}
