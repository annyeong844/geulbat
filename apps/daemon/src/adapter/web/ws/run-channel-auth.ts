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
): void {
  const socketState = getSocketState(socket);

  if (socketState.authenticated) {
    sendError(
      socket,
      requestId,
      409,
      'conflict',
      'socket already authenticated',
    );
    return;
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
      return;
    }
    closeUnauthorized(socket, requestId, 'invalid websocket auth token');
    return;
  }

  socketState.authenticated = true;
  clearShellAuthFailures(socketState.remoteAddress);
  if (socketState.authTimeout) {
    clearTimeout(socketState.authTimeout);
    socketState.authTimeout = null;
  }

  sendMessage(socket, { type: 'run.auth.ok', requestId, ok: true });
}
