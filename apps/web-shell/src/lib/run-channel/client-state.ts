type RunChannelConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export interface RunChannelConnectionState {
  phase: RunChannelConnectionPhase;
  reconnectAttempts: number;
  reconnectTask: unknown | null;
  closedExplicitly: boolean;
}

export function createInitialRunChannelConnectionState(): RunChannelConnectionState {
  return {
    phase: 'idle',
    reconnectAttempts: 0,
    reconnectTask: null,
    closedExplicitly: false,
  };
}

export function beginConnectionAttempt(
  state: RunChannelConnectionState,
): RunChannelConnectionState {
  return {
    ...state,
    phase: 'connecting',
    closedExplicitly: false,
  };
}

export function markAuthHandshakeStarted(
  state: RunChannelConnectionState,
): RunChannelConnectionState {
  return {
    ...state,
    phase: 'authenticating',
  };
}

export function markConnectionReady(
  state: RunChannelConnectionState,
): RunChannelConnectionState {
  return {
    ...state,
    phase: 'connected',
    reconnectAttempts: 0,
    reconnectTask: null,
    closedExplicitly: false,
  };
}

export function markConnectionClosed(
  state: RunChannelConnectionState,
  explicit: boolean,
): RunChannelConnectionState {
  return {
    ...state,
    phase: explicit ? 'closed' : 'idle',
    reconnectTask: explicit ? null : state.reconnectTask,
    closedExplicitly: explicit,
  };
}

export function canScheduleReconnect(
  state: RunChannelConnectionState,
  maxReconnectAttempts: number = Number.POSITIVE_INFINITY,
): boolean {
  return (
    !state.closedExplicitly &&
    state.reconnectTask == null &&
    state.reconnectAttempts < maxReconnectAttempts
  );
}

export function markReconnectScheduled(
  state: RunChannelConnectionState,
  task: unknown,
): RunChannelConnectionState {
  return {
    ...state,
    phase: 'reconnecting',
    reconnectAttempts: state.reconnectAttempts + 1,
    reconnectTask: task,
  };
}

export function clearReconnectSchedule(
  state: RunChannelConnectionState,
): RunChannelConnectionState {
  return {
    ...state,
    reconnectTask: null,
    phase: state.closedExplicitly ? 'closed' : 'idle',
  };
}

export function markReconnectFailed(
  state: RunChannelConnectionState,
): RunChannelConnectionState {
  return {
    ...state,
    phase: 'failed',
    reconnectTask: null,
  };
}
