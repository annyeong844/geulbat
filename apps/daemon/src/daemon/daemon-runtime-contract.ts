import type { RunId, ThreadId } from '@geulbat/protocol/ids';
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
import type { ResourceBudgetProvider } from './agent/resource-budget-provider.js';
import type { SubagentAdmissionController } from './agent/subagent-concurrency.js';
import type {
  BackgroundChildResult,
  ProviderRunSelection,
  ResolvedChildModelPin,
  RunSubagentModelRouting,
  SubagentLaunchReservation,
  SubagentType,
} from './subagent-runtime-contracts.js';
import type { AgentEvent, ToolRunState } from './runtime-contracts.js';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunContext } from './run-context.js';
import type { PtcFixedEpochProbeRuntimeResult } from './ptc/runtime/probes/fixed-probe-runtime-contract.js';
import type { PtcBrowserPageLoadEvidenceRuntime } from './ptc/runtime/browser/browser-page-load-evidence-runtime-contract.js';
import type { PtcBrowserTextEvidenceRuntime } from './ptc/runtime/browser/browser-text-evidence-runtime-contract.js';
import type { PtcBrowserNavigateRuntime } from './ptc/runtime/browser/browser-navigate-runtime-contract.js';
import type {
  PtcExecuteCodeRuntime,
  PtcPackageInstallRuntime,
} from './ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type {
  ImageGenerationRuntime,
  VideoGenerationRuntime,
} from './media/contract.js';
import type { ToolLibraryProjectionPort } from './tools/tool-library-projection-port.js';
import type { PluginSkillRuntime } from './extensions/plugin-skill-runtime.js';
import type { RunCheckpointStore } from './sessions/run-checkpoint-store.js';

export type {
  ProviderRunSelection,
  ResolvedChildModelPin,
  RunSubagentModelRouting,
};

export type AgentMemoryIndex = Pick<
  MemoryIndexStore,
  'refreshMemoryIndex' | 'computeCurrentSourceSnapshot' | 'loadMemoryIndex'
>;

export interface StartSubagentBackgroundRunArgs {
  task: string;
  subagentType: SubagentType;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  stateRoot: string;
  workingDirectory: string;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation?: SubagentLaunchReservation;
  approvalSessionId?: string;
  permissionMode?: PermissionMode;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent?: (event: AgentEvent) => void;
  timeoutMs?: number;
  childRunId?: RunId;
  childThreadId?: ThreadId;
}

export interface SubagentRunLauncher {
  startBackgroundRun(
    this: void,
    args: StartSubagentBackgroundRunArgs,
  ): Promise<{
    ok: true;
    output: string;
  }>;
}

export interface PtcFixedEpochProbeRuntime {
  runFixedEpochProbe(args: {
    runContext: RunContext;
    signal?: AbortSignal;
  }): Promise<PtcFixedEpochProbeRuntimeResult>;
}

export interface AgentRuntimeServices {
  activeRuns: Pick<
    ActiveRunStore,
    'abortRunSubtree' | 'finishRun' | 'tryStartRun'
  >;
  approvalGrants: ApprovalGrantStore;
  approvalGate: Pick<ApprovalGate, 'waitForApproval'>;
  backgroundNotifications: {
    enqueueThreadBackgroundResult(
      threadId: ThreadId,
      result: BackgroundChildResult,
    ): void;
    consumeThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
    readThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
    acknowledgeThreadBackgroundResults(
      threadId: ThreadId,
      deliveryIds: readonly string[],
    ): void;
  };
  childRuns: ChildRunRegistry;
  computerFileRoot?: string;
  fileStateCache: FileStateCache;
  imageGeneration: ImageGenerationRuntime;
  videoGeneration: VideoGenerationRuntime;
  memoryIndex: AgentMemoryIndex;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
  runCheckpoints: RunCheckpointStore;
  reactBundleStructuredOutputIngressPolicy: ReactBundleStructuredOutputIngressPolicy;
  resourceBudgetProvider: ResourceBudgetProvider;
  ptcBrowserPageLoadEvidence: PtcBrowserPageLoadEvidenceRuntime;
  ptcBrowserTextEvidence: PtcBrowserTextEvidenceRuntime;
  ptcBrowserNavigate: PtcBrowserNavigateRuntime;
  ptcExecuteCode: PtcExecuteCodeRuntime;
  ptcPackageInstall: PtcPackageInstallRuntime;
  ptcFixedProbe: PtcFixedEpochProbeRuntime;
  pluginSkills: PluginSkillRuntime;
  sandboxAttempts: SandboxAttemptStore;
  subagentAdmission: SubagentAdmissionController;
  subagentRuns: SubagentRunLauncher;
  toolLibraryProjection: ToolLibraryProjectionPort;
  toolRegistry: ToolRuntimeRegistry;
}
