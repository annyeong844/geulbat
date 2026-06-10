import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadId } from '@geulbat/protocol/ids';
import { createLogger } from '@geulbat/shared-utils/logger';

import { mapBackgroundSubagentTerminalToRunEvent } from '../protocol/map-events.js';
import { sendMessage } from './run-channel-socket.js';
import {
  cleanupSocketRuntimeState,
  clearSocketHeartbeatRuntime,
} from './run-channel-socket-cleanup.js';
import type {
  RunChannelSocketCleanupContext,
  RunChannelSubscriptionContext,
} from './run-channel-runtime-context.js';
import { getErrorMessage } from '../../../daemon/utils/error.js';

const logger = createLogger('run-channel/heartbeat');

// Runtime state owns per-socket authorization, subscriptions, and run cleanup.
export interface RunChannelSocketState {
  approvalSessionId: string;
  authenticated: boolean;
  upgradeAuthorized: boolean;
  remoteAddress: string | null;
  activeRunIds: Set<CancelRequest['runId']>;
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
    approvalSessionId: randomUUID(),
    authenticated: false,
    upgradeAuthorized: false,
    remoteAddress: null,
    activeRunIds: new Set<CancelRequest['runId']>(),
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

export function ensureThreadBackgroundSubscription(
  socket: WebSocket,
  threadId: ThreadId,
  subscriptionContext: RunChannelSubscriptionContext,
): void {
  const state = getSocketState(socket);
  if (state.threadUnsubscribes.has(threadId)) {
    return;
  }

  const unsubscribe =
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
              subagentType: result.subagentType,
              terminalState: result.terminalState,
              ok: result.terminalState === 'completed',
              ...(result.reason ? { reason: result.reason } : {}),
              result: result.result,
            },
          ),
        });
      },
    );

  state.threadUnsubscribes.set(threadId, unsubscribe);
}

export function socketOwnsRun(
  socket: WebSocket,
  runId: CancelRequest['runId'],
): boolean {
  return getSocketState(socket).activeRunIds.has(runId);
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
