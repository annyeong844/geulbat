import type WebSocket from 'ws';

import {
  clearShellAuthFailures,
  recordShellAuthFailure,
} from '#web/auth/auth-failure-rate-limit.js';
import { isAuthorizedShellWebSocketToken } from '#web/auth/shell-auth.js';
import {
  closeUnauthorized,
  sendError,
  sendMessage,
} from './run-channel-socket.js';
import { getSocketState } from './run-channel-socket-runtime.js';

export function handleRunAuth(
  socket: WebSocket,
  requestId: string,
  token: string,
  computerSessionId: string,
): void {
  if (!authenticateRunSocket(socket, requestId, token)) {
    return;
  }
  getSocketState(socket).computerSessionId = computerSessionId;
  if (completeRunSocketAuthentication(socket)) {
    sendMessage(socket, {
      type: 'run.auth.ok',
      requestId,
      ok: true,
      computerSessionId,
    });
  }
}

export function authenticateRunSocket(
  socket: WebSocket,
  requestId: string,
  token: string,
): boolean {
  const socketState = getSocketState(socket);

  if (socketState.authenticated) {
    sendError(
      socket,
      requestId,
      409,
      'conflict',
      'socket already authenticated',
    );
    return false;
  }
  if (socketState.authenticationPending) {
    sendError(
      socket,
      requestId,
      409,
      'conflict',
      'socket authentication already in progress',
    );
    return false;
  }

  if (
    !socketState.upgradeAuthorized &&
    !isAuthorizedShellWebSocketToken(token)
  ) {
    const result = recordShellAuthFailure(socketState.remoteAddress);
    if (result.limited) {
      sendError(
        socket,
        requestId,
        429,
        'rate_limited',
        'too many authentication failures; retry later',
      );
      socket.close(1008, 'rate_limited');
      return false;
    }
    closeUnauthorized(socket, requestId, 'invalid websocket auth token');
    return false;
  }

  socketState.authenticationPending = true;
  clearShellAuthFailures(socketState.remoteAddress);
  if (socketState.authTimeout) {
    clearTimeout(socketState.authTimeout);
    socketState.authTimeout = null;
  }

  return true;
}

export function completeRunSocketAuthentication(socket: WebSocket): boolean {
  const socketState = getSocketState(socket);
  socketState.authenticationPending = false;
  if (socketState.closed) {
    return false;
  }
  socketState.authenticated = true;
  return true;
}

export function abortRunSocketAuthentication(socket: WebSocket): void {
  const socketState = getSocketState(socket);
  socketState.authenticationPending = false;
  if (!socketState.closed) {
    socket.close(1011, 'authentication synchronization failed');
  }
}
