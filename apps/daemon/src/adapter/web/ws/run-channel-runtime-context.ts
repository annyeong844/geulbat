import type { ThreadId } from '@geulbat/protocol/ids';
import type {
  RunToolRequest,
  RunToolResultPayload,
} from '@geulbat/protocol/run-channel';

import type { AgentRuntimeServices } from '../../../daemon/daemon-runtime-contract.js';
import type { ApprovalGate } from '../../../daemon/agent/runtime/approval-gate.js';
import type { BackgroundNotificationQueue } from '../../../daemon/agent/runtime/background-notification-queue.js';
import type { ActiveRunStore } from '../../../daemon/sessions/active-runs.js';
import type { ComputerFileScope } from '../../../daemon/files/computer-file-scope.js';

type RunChannelActiveRuns = AgentRuntimeServices['activeRuns'] &
  Pick<
    ActiveRunStore,
    | 'abortThreadTree'
    | 'appendPendingInterject'
    | 'cancelPendingInterject'
    | 'requestPendingInterjectFlush'
    | 'getRunById'
    | 'getRunByThreadId'
  >;

type RunChannelApprovalGate = AgentRuntimeServices['approvalGate'] &
  Pick<
    ApprovalGate,
    | 'clearApprovalSessionRuntime'
    | 'hasPendingApprovalForSession'
    | 'resolveApproval'
  >;

type RunChannelBackgroundNotifications =
  AgentRuntimeServices['backgroundNotifications'] &
    Pick<BackgroundNotificationQueue, 'subscribeThreadBackgroundResults'>;

export type RunChannelArtifactFrameToolDispatch = (args: {
  threadId: ThreadId;
  runId: string;
  workingDirectory: string;
  approvalSessionId: string;
  toolName: RunToolRequest['toolName'];
  toolArgs: RunToolRequest['args'];
  scopeHandle: RunToolRequest['scopeHandle'];
  frameRequestId: RunToolRequest['frameRequestId'];
}) => Promise<RunToolResultPayload>;

export type RunChannelRuntimeContext = Omit<
  AgentRuntimeServices,
  'activeRuns' | 'approvalGate' | 'backgroundNotifications'
> & {
  activeRuns: RunChannelActiveRuns;
  approvalGate: RunChannelApprovalGate;
  artifactFrameToolDispatch: RunChannelArtifactFrameToolDispatch;
  backgroundNotifications: RunChannelBackgroundNotifications;
  computerFileScope?: ComputerFileScope;
  homeStateRoot: string;
};

export type RunChannelControlContext = Pick<
  RunChannelRuntimeContext,
  'activeRuns' | 'approvalGate'
>;

export type RunChannelSubscriptionContext = Pick<
  RunChannelRuntimeContext,
  'backgroundNotifications'
>;

export type RunChannelSocketCleanupContext = Pick<
  RunChannelRuntimeContext,
  'activeRuns' | 'approvalGate'
>;
