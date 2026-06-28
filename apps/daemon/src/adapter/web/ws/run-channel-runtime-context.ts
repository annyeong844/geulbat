import type { ProjectScopeRegistry } from '#web/request/project-scope.js';
import type { AgentRuntimeServices } from '../../../daemon/daemon-runtime-contract.js';
import type { ApprovalGate } from '../../../daemon/agent/runtime/approval-gate.js';
import type { BackgroundNotificationQueue } from '../../../daemon/agent/runtime/background-notification-queue.js';
import type { ActiveRunStore } from '../../../daemon/sessions/active-runs.js';

type RunChannelActiveRuns = AgentRuntimeServices['activeRuns'] &
  Pick<
    ActiveRunStore,
    'abortThreadTree' | 'appendPendingInterject' | 'getRunById'
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

export type RunChannelRuntimeContext = Omit<
  AgentRuntimeServices,
  'activeRuns' | 'approvalGate' | 'backgroundNotifications'
> & {
  activeRuns: RunChannelActiveRuns;
  approvalGate: RunChannelApprovalGate;
  backgroundNotifications: RunChannelBackgroundNotifications;
  projectRegistry: ProjectScopeRegistry;
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
