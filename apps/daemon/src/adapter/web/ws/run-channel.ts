import type { Server } from 'node:http';
import { WebSocketServer, type RawData } from 'ws';
import { tryDecodeJson } from '@geulbat/protocol/runtime-utils';

import { getErrorMessage } from '../../../daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { readConfiguredAllowedOrigins } from '#web/origin-policy.js';
import { handleClientMessage } from './run-channel-dispatch.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import {
  closeUnauthorized,
  rejectUpgrade,
  sendError,
} from './run-channel-socket.js';
import {
  cleanupSocketState,
  getSocketState,
  markSocketHeartbeatPong,
  startSocketHeartbeat,
  trackSocketMessageDispatch,
} from './run-channel-socket-runtime.js';
import { readRunChannelUpgrade } from './run-channel-upgrade.js';
import { isUpgradeHandled, markUpgradeHandled } from './upgrade-handled.js';

const RUN_CHANNEL_MAX_PAYLOAD_BYTES = 1024 * 1024;
const RUN_CHANNEL_AUTH_TIMEOUT_MS = 5_000;
const RUN_CHANNEL_HEARTBEAT_INTERVAL_MS = 30_000;
const RUN_CHANNEL_HEARTBEAT_PONG_TIMEOUT_MS = 10_000;
const logger = createLogger('run-channel/message');

export function attachRunChannelServer(
  server: Server,
  args: {
    runtimeContext: RunChannelRuntimeContext;
    heartbeatIntervalMs?: number;
    heartbeatPongTimeoutMs?: number;
  },
): WebSocketServer {
  const configuredAllowedOrigins = readConfiguredAllowedOrigins();
  const { runtimeContext } = args;
  const heartbeatIntervalMs =
    args.heartbeatIntervalMs ?? RUN_CHANNEL_HEARTBEAT_INTERVAL_MS;
  const heartbeatPongTimeoutMs =
    args.heartbeatPongTimeoutMs ?? RUN_CHANNEL_HEARTBEAT_PONG_TIMEOUT_MS;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: RUN_CHANNEL_MAX_PAYLOAD_BYTES,
  });

  wss.on('connection', (socket) => {
    const socketState = getSocketState(socket);
    socketState.authTimeout = setTimeout(() => {
      if (!socketState.authenticated) {
        closeUnauthorized(
          socket,
          undefined,
          'websocket authentication required',
        );
      }
    }, RUN_CHANNEL_AUTH_TIMEOUT_MS);
    startSocketHeartbeat(socket, {
      intervalMs: heartbeatIntervalMs,
      pongTimeoutMs: heartbeatPongTimeoutMs,
    });

    socket.on('message', (data) => {
      const rawMessage = decodeRunChannelMessage(data);
      const dispatch = handleClientMessage(
        socket,
        rawMessage,
        runtimeContext,
      ).catch((error: unknown) => {
        logger.error('unexpected error:', getErrorMessage(error));
        sendError(
          socket,
          readRequestIdFromRawMessage(rawMessage),
          500,
          'internal',
          'internal websocket error',
        );
      });
      trackSocketMessageDispatch(socket, dispatch);
    });

    socket.on('pong', () => {
      markSocketHeartbeatPong(socket);
    });

    socket.on('close', () => {
      cleanupSocketState(socket, runtimeContext);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const upgrade = readRunChannelUpgrade(req, configuredAllowedOrigins);
    if (!upgrade.ok && upgrade.kind === 'ignore') {
      if (!isUpgradeHandled(req)) {
        socket.destroy();
      }
      return;
    }
    if (!upgrade.ok) {
      rejectUpgrade(
        socket,
        upgrade.statusCode,
        upgrade.statusText,
        upgrade.body,
      );
      return;
    }

    markUpgradeHandled(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const socketState = getSocketState(ws);
      socketState.upgradeAuthorized = upgrade.upgradeAuthorized;
      socketState.remoteAddress = upgrade.remoteAddress;
      wss.emit('connection', ws, req);
    });
  });

  return wss;
}

function decodeRunChannelMessage(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

function readRequestIdFromRawMessage(rawMessage: string): string | undefined {
  const decoded = tryDecodeJson(rawMessage, (value) => value);
  if (!decoded.ok || typeof decoded.value !== 'object' || !decoded.value) {
    return undefined;
  }
  const requestId = (decoded.value as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' && requestId.trim()
    ? requestId
    : undefined;
}
