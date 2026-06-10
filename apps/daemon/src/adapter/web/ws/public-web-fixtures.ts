import type { Server } from 'node:http';

import { PUBLIC_WEB_WEBSOCKET_ECHO_PATH } from '@geulbat/protocol/public-web-fixtures';
import WebSocket, { WebSocketServer } from 'ws';

import { readConfiguredAllowedOrigins } from '#web/origin-policy.js';
import {
  getRequestUrl,
  isAllowedWebSocketOrigin,
  rejectUpgrade,
} from './run-channel-socket.js';
import { markUpgradeHandled } from './upgrade-handled.js';

const PUBLIC_WEB_WEBSOCKET_MAX_PAYLOAD_BYTES = 64 * 1024;

export function attachPublicWebFixtureWebSocketServer(
  server: Server,
): WebSocketServer {
  const configuredAllowedOrigins = readConfiguredAllowedOrigins();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: PUBLIC_WEB_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });

  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(data, { binary: isBinary });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = getRequestUrl(req);
    if (url.pathname !== PUBLIC_WEB_WEBSOCKET_ECHO_PATH) {
      return;
    }

    markUpgradeHandled(req);
    const origin =
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedWebSocketOrigin(origin, configuredAllowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'origin not allowed');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return wss;
}
