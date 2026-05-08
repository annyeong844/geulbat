import type { ProjectId, RunId, ThreadId } from '@geulbat/protocol/ids';
import type { ProviderAuthRuntimeStore } from './auth/runtime-state.js';
import type { ResponsesWebSocketSessionStore } from './llm/provider/transport/responses-websocket-session.js';
import type { ActiveRunStore } from './sessions/active-runs.js';
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
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
  subagentAdmission: SubagentAdmissionController;
  subagentRuns: SubagentRunLauncher;
  toolRegistry: ToolRuntimeRegistry;
}
