import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadId } from '@geulbat/protocol/ids';
import type { RunEventReplayCursor } from '@geulbat/protocol/run-channel';
import { createLogger } from '@geulbat/structured-logger/logger';

import {
  mapAgentEventToRunEvent,
  mapBackgroundSubagentTerminalToRunEvent,
} from '../protocol/map-events.js';
import {
  sendMessage,
  sendRunEvent,
  sendToolOutputDelta,
} from './run-channel-socket.js';
import {
  cleanupSocketRuntimeState,
  clearSocketHeartbeatRuntime,
} from './run-channel-socket-cleanup.js';
import type {
  RunChannelSocketCleanupContext,
  RunChannelRuntimeContext,
  RunChannelSubscriptionContext,
} from './run-channel-runtime-context.js';
import type { LiveRunEventSink } from '../../../daemon/sessions/live-run-events.js';
import { getErrorMessage } from '../../../daemon/utils/error.js';
import {
  resolveSubagentToolSurfaceProfile,
  type ChildRunSnapshot,
} from '../../../daemon/subagent-runtime-contracts.js';

const logger = createLogger('run-channel/heartbeat');

// Runtime state owns per-socket authorization, subscriptions, and run cleanup.
export interface RunChannelSocketState {
  computerSessionId: string;
  authenticated: boolean;
  authenticationPending: boolean;
  upgradeAuthorized: boolean;
  remoteAddress: string | null;
  activeRunIds: Set<CancelRequest['runId']>;
  ownedRunIds: Set<CancelRequest['runId']>;
  runStartInFlightRequestId: string | null;
  threadSeqByThread: Map<ThreadId, number>;
  threadUnsubscribes: Map<ThreadId, () => void>;
  messageDispatches: Set<Promise<void>>;
  authTimeout: NodeJS.Timeout | null;
  heartbeatInterval: NodeJS.Timeout | null;
  heartbeatTimeout: NodeJS.Timeout | null;
  awaitingPong: boolean;
  closed: boolean;
}

interface RunChannelHeartbeatOptions {
  intervalMs: number;
  pongTimeoutMs: number;
}

const socketStateBySocket = new WeakMap<WebSocket, RunChannelSocketState>();

export function getSocketState(socket: WebSocket): RunChannelSocketState {
  const state = socketStateBySocket.get(socket);
  if (state) {
    return state;
  }

  const next: RunChannelSocketState = {
    // Provisional only. A valid run.auth replaces this before run recovery or
    // binding, so socket lifetime never becomes approval authority.
    computerSessionId: randomUUID(),
    authenticated: false,
    authenticationPending: false,
    upgradeAuthorized: false,
    remoteAddress: null,
    activeRunIds: new Set<CancelRequest['runId']>(),
    ownedRunIds: new Set<CancelRequest['runId']>(),
    runStartInFlightRequestId: null,
    threadSeqByThread: new Map<ThreadId, number>(),
    threadUnsubscribes: new Map<ThreadId, () => void>(),
    messageDispatches: new Set<Promise<void>>(),
    authTimeout: null,
    heartbeatInterval: null,
    heartbeatTimeout: null,
    awaitingPong: false,
    closed: false,
  };
  socketStateBySocket.set(socket, next);
  return next;
}

export function trackSocketMessageDispatch(
  socket: WebSocket,
  dispatch: Promise<void>,
): void {
  const state = getSocketState(socket);
  state.messageDispatches.add(dispatch);
  const release = () => {
    state.messageDispatches.delete(dispatch);
    if (state.closed && state.messageDispatches.size === 0) {
      socketStateBySocket.delete(socket);
    }
  };
  void dispatch.then(release, release);
}

export function startSocketHeartbeat(
  socket: WebSocket,
  options: RunChannelHeartbeatOptions,
): void {
  const state = getSocketState(socket);
  clearSocketHeartbeatRuntime(state);
  if (options.intervalMs <= 0 || options.pongTimeoutMs <= 0) {
    return;
  }

  state.heartbeatInterval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN || state.awaitingPong) {
      return;
    }

    state.awaitingPong = true;
    state.heartbeatTimeout = setTimeout(() => {
      if (!state.awaitingPong) {
        return;
      }
      logger
        .withContext({
          activeRunCount: state.activeRunIds.size,
          pongTimeoutMs: options.pongTimeoutMs,
          remoteAddress: state.remoteAddress,
        })
        .warn('terminating websocket after missed heartbeat pong');
      socket.terminate();
    }, options.pongTimeoutMs);

    try {
      socket.ping();
    } catch (error: unknown) {
      logger
        .withContext({
          activeRunCount: state.activeRunIds.size,
          remoteAddress: state.remoteAddress,
        })
        .warn('terminating websocket after heartbeat ping failed:', {
          message: getErrorMessage(error),
        });
      socket.terminate();
    }
  }, options.intervalMs);
}

export function markSocketHeartbeatPong(socket: WebSocket): void {
  const state = getSocketState(socket);
  state.awaitingPong = false;
  if (state.heartbeatTimeout) {
    clearTimeout(state.heartbeatTimeout);
    state.heartbeatTimeout = null;
  }
}

export function nextSocketThreadSeq(
  socket: WebSocket,
  threadId: ThreadId,
): number {
  const state = getSocketState(socket);
  const current = state.threadSeqByThread.get(threadId) ?? 0;
  state.threadSeqByThread.set(threadId, current + 1);
  return current;
}

function sendActiveChildStatus(
  socket: WebSocket,
  threadId: ThreadId,
  child: ChildRunSnapshot,
): void {
  sendMessage(socket, {
    type: 'run.event',
    event: mapAgentEventToRunEvent(
      child.parentRunId,
      threadId,
      nextSocketThreadSeq(socket, threadId),
      {
        type: 'subagent_status',
        payload: {
          parentRunId: child.parentRunId,
          childRunId: child.childRunId,
          childThreadId: child.childThreadId,
          subagentType: child.subagentType,
          ...(child.capabilities === undefined
            ? {}
            : {
                capabilities: child.capabilities,
                toolSurface: resolveSubagentToolSurfaceProfile({
                  subagentType: child.subagentType,
                  capabilities: child.capabilities,
                }),
              }),
          modelId: child.modelPin.modelId,
          reasoningEffort: child.modelPin.providerRunSelection.reasoningEffort,
          selectionSource: child.modelPin.selectionSource,
          runtime: child.runtime,
        },
      },
    ),
  });
}

export function ensureThreadBackgroundSubscription(
  socket: WebSocket,
  threadId: ThreadId,
  subscriptionContext: RunChannelSubscriptionContext,
): void {
  const state = getSocketState(socket);
  if (state.threadUnsubscribes.has(threadId)) {
    return;
  }

  const unsubscribeBackgroundResults =
    subscriptionContext.backgroundNotifications.subscribeThreadBackgroundResults(
      threadId,
      (result) => {
        sendMessage(socket, {
          type: 'run.event',
          event: mapBackgroundSubagentTerminalToRunEvent(
            result.childRunId,
            threadId,
            nextSocketThreadSeq(socket, threadId),
            {
              deliveryId: result.deliveryId,
              parentRunId: result.parentRunId,
              childRunId: result.childRunId,
              ...(result.childThreadId !== undefined
                ? { childThreadId: result.childThreadId }
                : {}),
              subagentType: result.subagentType,
              ...(result.capabilities !== undefined
                ? { capabilities: result.capabilities }
                : {}),
              ...(result.toolSurface !== undefined
                ? { toolSurface: result.toolSurface }
                : {}),
              ...(result.runtime !== undefined
                ? { runtime: result.runtime }
                : {}),
              terminalState: result.terminalState,
              ok: result.terminalState === 'completed',
              ...(result.reason ? { reason: result.reason } : {}),
              result: result.result,
              ...(result.resultRef === undefined
                ? {}
                : { resultRef: result.resultRef }),
              ...(result.elapsedMs !== undefined
                ? { elapsedMs: result.elapsedMs }
                : {}),
              ...(result.usage !== undefined ? { usage: result.usage } : {}),
              ...(result.modelId !== undefined
                ? { modelId: result.modelId }
                : {}),
              ...(result.reasoningEffort !== undefined
                ? { reasoningEffort: result.reasoningEffort }
                : {}),
            },
          ),
        });
      },
    );
  const unsubscribeActiveChildren =
    subscriptionContext.childRuns.subscribeActiveChildRunUpdates(
      threadId,
      (child) => {
        sendActiveChildStatus(socket, threadId, child);
      },
    );

  state.threadUnsubscribes.set(threadId, () => {
    unsubscribeBackgroundResults();
    unsubscribeActiveChildren();
  });

  for (const child of subscriptionContext.childRuns.getActiveChildRunsByOwnerThread(
    threadId,
  )) {
    sendMessage(socket, {
      type: 'run.event',
      event: mapAgentEventToRunEvent(
        child.parentRunId,
        threadId,
        nextSocketThreadSeq(socket, threadId),
        {
          type: 'subagent_spawned',
          payload: {
            parentRunId: child.parentRunId,
            childRunId: child.childRunId,
            childThreadId: child.childThreadId,
            subagentType: child.subagentType,
            ...(child.capabilities === undefined
              ? {}
              : {
                  capabilities: child.capabilities,
                  toolSurface: resolveSubagentToolSurfaceProfile({
                    subagentType: child.subagentType,
                    capabilities: child.capabilities,
                  }),
                }),
            modelId: child.modelPin.modelId,
            reasoningEffort:
              child.modelPin.providerRunSelection.reasoningEffort,
            selectionSource: child.modelPin.selectionSource,
            runtime: child.runtime,
          },
        },
      ),
    });
  }
}

export function createSocketRunEventSink(socket: WebSocket): LiveRunEventSink {
  const sink: LiveRunEventSink = (envelope) => {
    const { runId, threadId, seq, event } = envelope;
    const delivered = sendRunEvent(socket, runId, threadId, seq, event);
    if (delivered && (event.type === 'done' || event.type === 'error')) {
      getSocketState(socket).activeRunIds.delete(runId);
    }
    return delivered;
  };
  sink.transient = ({ runId, threadId, event }) =>
    sendToolOutputDelta(socket, runId, threadId, event.payload);
  return sink;
}

export async function bindSocketRuns(
  socket: WebSocket,
  runtimeContext: RunChannelRuntimeContext,
  runEventCursors?: readonly RunEventReplayCursor[],
): Promise<number> {
  const state = getSocketState(socket);
  const afterSeqByRun =
    runEventCursors === undefined
      ? undefined
      : new Map(runEventCursors.map((cursor) => [cursor.runId, cursor.seq]));
  const bound = await runtimeContext.liveRunEvents.bindRuns({
    ownerId: state.computerSessionId,
    sink: createSocketRunEventSink(socket),
    ...(afterSeqByRun === undefined ? {} : { afterSeqByRun }),
  });
  for (const run of bound) {
    state.ownedRunIds.add(run.runId);
    ensureThreadBackgroundSubscription(socket, run.threadId, runtimeContext);
    if (run.terminal) {
      continue;
    }
    state.activeRunIds.add(run.runId);
  }
  for (const child of runtimeContext.childRuns.getActiveChildRuns()) {
    state.ownedRunIds.add(child.parentRunId);
    ensureThreadBackgroundSubscription(
      socket,
      child.ownerThreadId,
      runtimeContext,
    );
  }
  return bound.length;
}

export function socketOwnsRun(
  socket: WebSocket,
  runId: CancelRequest['runId'],
): boolean {
  const state = getSocketState(socket);
  return state.activeRunIds.has(runId) || state.ownedRunIds.has(runId);
}

export function cleanupSocketState(
  socket: WebSocket,
  cleanupContext: RunChannelSocketCleanupContext,
): void {
  const state = getSocketState(socket);
  state.closed = true;
  cleanupSocketRuntimeState(state, cleanupContext);
  if (state.messageDispatches.size === 0) {
    socketStateBySocket.delete(socket);
  }
}
