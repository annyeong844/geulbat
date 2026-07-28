import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadId } from '@geulbat/protocol/ids';

import type { LiveRunEventSink } from '../../../daemon/sessions/live-run-events.js';
import type { RunChannelSocketCleanupContext } from './run-channel-runtime-context.js';

interface RunChannelCleanupSocketState {
  activeRunIds: Set<CancelRequest['runId']>;
  ownedRunIds: Set<CancelRequest['runId']>;
  runStartInFlightRequestId: string | null;
  threadSeqByThread: Map<ThreadId, number>;
  threadUnsubscribes: Map<ThreadId, () => void>;
  runEventSink: LiveRunEventSink | null;
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
    activeRunIds,
    ownedRunIds,
    authTimeout,
    threadUnsubscribes,
    threadSeqByThread,
  } = state;
  if (authTimeout) {
    clearTimeout(authTimeout);
  }
  clearSocketHeartbeatRuntime(state);
  // 승인 grant/대기 상태는 소켓이 아니라 host-issued computer session의
  // 소유다. close 시점에는 이 소켓의 이벤트 sink만 떼고 같은 session의
  // 승인 상태와 다른 소켓 subscriber는 남긴다.
  if (state.runEventSink !== null) {
    cleanupContext.liveRunEvents.detachSink(state.runEventSink);
    state.runEventSink = null;
  }
  for (const unsubscribe of threadUnsubscribes.values()) {
    unsubscribe();
  }
  threadUnsubscribes.clear();
  threadSeqByThread.clear();
  activeRunIds.clear();
  ownedRunIds.clear();
  state.runStartInFlightRequestId = null;
}
