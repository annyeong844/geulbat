import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadId } from '@geulbat/protocol/ids';

import type { RunChannelSocketCleanupContext } from './run-channel-runtime-context.js';

interface RunChannelCleanupSocketState {
  computerSessionId: string;
  activeRunIds: Set<CancelRequest['runId']>;
  ownedRunIds: Set<CancelRequest['runId']>;
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
    computerSessionId,
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
  // 승인 grant/대기 상태는 소켓이 아니라 명시적 computer session의
  // 소유다. 같은 computerSessionId를 제시한 재연결만 이어받을 수 있으므로
  // close 시점에는 이벤트 sink만 떼고 승인 상태는 남긴다.
  cleanupContext.liveRunEvents.detachOwner(computerSessionId);
  for (const unsubscribe of threadUnsubscribes.values()) {
    unsubscribe();
  }
  threadUnsubscribes.clear();
  threadSeqByThread.clear();
  activeRunIds.clear();
  ownedRunIds.clear();
  state.runStartInFlightRequestId = null;
}
