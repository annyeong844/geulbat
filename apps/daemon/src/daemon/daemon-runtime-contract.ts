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
import type {
  SubagentAdmissionController,
  SubagentLaunchPromotionController,
} from './agent/subagent-concurrency.js';
import type {
  BackgroundChildResult,
  ResolvedChildModelPin,
  RunSubagentModelRouting,
  SubagentCapability,
  SubagentLaunchRequestStore,
  SubagentLaunchReservation,
  SubagentTerminalDeliveryStore,
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
import type { PlanningWorkflowStore } from './sessions/planning-workflow-store.js';
import type { GoalStore } from './sessions/goal-store.js';
import type { AgentLoopMemoryPort } from './agent/memory/compaction-loop.js';
import type { HostCommandRuntime } from '../command-host/contract.js';

export type AgentMemoryIndex = Pick<
  MemoryIndexStore,
  'refreshMemoryIndex' | 'computeCurrentSourceSnapshot' | 'loadMemoryIndex'
>;

export interface StartSubagentBackgroundRunArgs {
  task: string;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  stateRoot: string;
  workingDirectory: string;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation?: SubagentLaunchReservation;
  computerSessionId?: string;
  permissionMode?: PermissionMode;
  ultraReasoning?: boolean;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent?: (event: AgentEvent) => void;
  timeoutMs?: number;
  childRunId?: RunId;
  childThreadId?: ThreadId;
  durableLaunchRecorded?: true;
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

export interface AgentRuntimeAgentServices {
  loopMemory: AgentLoopMemoryPort;
  resourceBudgetProvider: ResourceBudgetProvider;
  reactBundleStructuredOutputIngressPolicy: ReactBundleStructuredOutputIngressPolicy;
}

interface AgentRuntimeProviderServices {
  authRuntime: ProviderAuthRuntimeStore;
  requestOptions: ProviderRequestOptions;
  webSocketSessions: ResponsesWebSocketSessionStore;
}

export interface AgentRuntimePtcServices {
  browserPageLoadEvidence: PtcBrowserPageLoadEvidenceRuntime;
  browserTextEvidence: PtcBrowserTextEvidenceRuntime;
  browserNavigate: PtcBrowserNavigateRuntime;
  executeCode: PtcExecuteCodeRuntime;
  packageInstall: PtcPackageInstallRuntime;
  fixedProbe: PtcFixedEpochProbeRuntime;
}

export interface AgentRuntimeSubagentServices {
  admission: SubagentAdmissionController;
  launchPromotions?: SubagentLaunchPromotionController;
  launchRequests?: SubagentLaunchRequestStore;
  terminalDeliveries?: SubagentTerminalDeliveryStore;
  runs: SubagentRunLauncher;
}

export interface AgentRuntimeServices {
  agent: AgentRuntimeAgentServices;
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
  hostCommands: HostCommandRuntime;
  /**
   * command-host 세션의 inline 결과 예산. 페이지 요청 상한이 이 값을 넘으면 세션이
   * invalid_args로 거부하므로(§4.2), 도구가 스트림을 페이지로 읽을 때 필요하다.
   * 조립이 호스트를 구성할 때 쓴 값을 그대로 넘긴다 — env를 다시 읽어 추정하지 않는다.
   */
  hostCommandInlineMaxBytes: number;
  imageGeneration: ImageGenerationRuntime;
  videoGeneration: VideoGenerationRuntime;
  memoryIndex: AgentMemoryIndex;
  provider: AgentRuntimeProviderServices;
  ptc: AgentRuntimePtcServices;
  runCheckpoints: RunCheckpointStore;
  planningWorkflows: PlanningWorkflowStore;
  goals: GoalStore;
  pluginSkills: PluginSkillRuntime;
  sandboxAttempts: SandboxAttemptStore;
  subagent: AgentRuntimeSubagentServices;
  threadIndex: Pick<
    typeof import('./sessions/threads-index.js'),
    'loadThreadIndex' | 'upsertThreadSummary'
  >;
  toolLibraryProjection: ToolLibraryProjectionPort;
  toolRegistry: ToolRuntimeRegistry;
}
