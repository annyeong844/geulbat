import type { ThreadId } from '@geulbat/protocol/ids';
import type {
  RunToolRequest,
  RunToolResultPayload,
} from '@geulbat/protocol/run-channel';

import type {
  AgentRuntimeAgentServices,
  AgentRuntimeServices,
} from '../../../daemon/daemon-runtime-contract.js';
import type { ApprovalGate } from '../../../daemon/agent/runtime/approval-gate.js';
import type { BackgroundNotificationQueue } from '../../../daemon/agent/runtime/background-notification-queue.js';
import type { ActiveRunStore } from '../../../daemon/sessions/active-runs.js';
import type { LiveRunEventStore } from '../../../daemon/sessions/live-run-events.js';
import type { RunCheckpointStore } from '../../../daemon/sessions/run-checkpoint-store.js';
import type { AgentLoopImplementationAdmission } from '../../../daemon/agent/loop-implementation-admission.js';
import type { ComputerFileScope } from '../../../daemon/files/computer-file-scope.js';

type RunChannelActiveRuns = AgentRuntimeServices['activeRuns'] &
  Pick<
    ActiveRunStore,
    | 'abortThreadTree'
    | 'abortRunSubtree'
    | 'appendPendingInterject'
    | 'cancelPendingInterject'
    | 'requestPendingInterjectFlush'
    | 'getRunById'
    | 'getRunByThreadId'
    | 'waitForThreadIdle'
  >;

type RunChannelApprovalGate = AgentRuntimeServices['approvalGate'] &
  Pick<
    ApprovalGate,
    | 'clearRunRuntime'
    | 'hasApprovalDecisionAuthority'
    | 'rebindPendingRunApprovals'
    | 'resolveApproval'
  >;

type RunChannelBackgroundNotifications =
  AgentRuntimeServices['backgroundNotifications'] &
    Pick<BackgroundNotificationQueue, 'subscribeThreadBackgroundResults'>;

type RunChannelArtifactFrameToolDispatch = (args: {
  threadId: ThreadId;
  runId: string;
  workingDirectory: string;
  computerSessionId: string;
  toolName: RunToolRequest['toolName'];
  toolArgs: RunToolRequest['args'];
  scopeHandle: RunToolRequest['scopeHandle'];
  frameRequestId: RunToolRequest['frameRequestId'];
}) => Promise<RunToolResultPayload>;

export type RunChannelRuntimeContext = Omit<
  AgentRuntimeServices,
  'activeRuns' | 'agent' | 'approvalGate' | 'backgroundNotifications'
> & {
  agent: AgentRuntimeAgentServices & {
    loopImplementationAdmission: AgentLoopImplementationAdmission;
  };
  activeRuns: RunChannelActiveRuns;
  approvalGate: RunChannelApprovalGate;
  artifactFrameToolDispatch: RunChannelArtifactFrameToolDispatch;
  backgroundNotifications: RunChannelBackgroundNotifications;
  computerFileScope?: ComputerFileScope;
  computerSessionId: string;
  homeStateRoot: string;
  liveRunEvents: LiveRunEventStore;
  runCheckpoints: RunCheckpointStore;
};

export type RunChannelControlContext = Pick<
  RunChannelRuntimeContext,
  'activeRuns' | 'approvalGate' | 'runCheckpoints'
>;

export type RunChannelSubscriptionContext = Pick<
  RunChannelRuntimeContext,
  'backgroundNotifications' | 'childRuns'
>;

export type RunChannelSocketCleanupContext = Pick<
  RunChannelRuntimeContext,
  'liveRunEvents'
>;
