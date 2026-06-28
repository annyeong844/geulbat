import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadId } from '@geulbat/protocol/ids';

import type { RunChannelSocketCleanupContext } from './run-channel-runtime-context.js';

interface RunChannelCleanupSocketState {
  approvalSessionId: string;
  activeRunIds: Set<CancelRequest['runId']>;
  runStartInFlightRequestId: string | null;
  threadSeqByThread: Map<ThreadId, number>;
  threadUnsubscribes: Map<ThreadId, () => void>;
  authTimeout: NodeJS.Timeout | null;
  heartbeatInterval: NodeJS.Timeout | null;
  heartbeatTimeout: NodeJS.Timeout | null;
  awaitingPong: boolean;
}

export function clearSocketHeartbeatRuntime(
  state: Pick<
    RunChannelCleanupSocketState,
    'heartbeatInterval' | 'heartbeatTimeout' | 'awaitingPong'
  >,
): void {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
  if (state.heartbeatTimeout) {
    clearTimeout(state.heartbeatTimeout);
    state.heartbeatTimeout = null;
  }
  state.awaitingPong = false;
}

export function cleanupSocketRuntimeState(
  state: RunChannelCleanupSocketState,
  cleanupContext: RunChannelSocketCleanupContext,
): void {
  const {
    approvalSessionId,
    activeRunIds,
    authTimeout,
    threadUnsubscribes,
    threadSeqByThread,
  } = state;
  if (authTimeout) {
    clearTimeout(authTimeout);
  }
  clearSocketHeartbeatRuntime(state);
  for (const runId of activeRunIds) {
    cleanupContext.activeRuns.abortTrackedRun(runId, 'socket_disconnect');
  }
  cleanupContext.approvalGate.clearApprovalSessionRuntime(approvalSessionId);
  for (const unsubscribe of threadUnsubscribes.values()) {
    unsubscribe();
  }
  threadUnsubscribes.clear();
  threadSeqByThread.clear();
  activeRunIds.clear();
  state.runStartInFlightRequestId = null;
}
