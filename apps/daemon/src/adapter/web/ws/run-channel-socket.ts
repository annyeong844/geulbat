import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import WebSocket from 'ws';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { RunEvent } from '@geulbat/protocol/run-events';
import type { ThreadId } from '@geulbat/protocol/ids';

import type { AgentEvent } from '../../../daemon/agent/events.js';
import { mapAgentEventToRunEvent } from '../protocol/map-events.js';
import { isAllowedBrowserOrigin } from '#web/origin-policy.js';

const WS_POLICY_VIOLATION_CLOSE_CODE = 1008;

// Transport helpers own websocket framing plus HTTP upgrade boundary checks.

export function sendMessage(
  socket: WebSocket,
  message: RunChannelServerMessage,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

export function sendError(
  socket: WebSocket,
  requestId: string | undefined,
  status: number,
  code: ErrorCode,
  message: string,
): void {
  sendMessage(socket, {
    type: 'run.error',
    status,
    code,
    message,
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

export function sendRunEvent(
  socket: WebSocket,
  runId: RunEvent['runId'],
  threadId: ThreadId,
  seq: number,
  agentEvent: AgentEvent,
): boolean {
  const event = mapAgentEventToRunEvent(runId, threadId, seq, agentEvent);
  return sendMessage(socket, { type: 'run.event', event });
}

export function closeUnauthorized(
  socket: WebSocket,
  requestId: string | undefined,
  message: string,
): void {
  sendError(socket, requestId, 401, 'unauthorized', message);
  socket.close(WS_POLICY_VIOLATION_CLOSE_CODE, 'unauthorized');
}

export function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  configuredAllowedOrigins: ReadonlySet<string>,
): boolean {
  return isAllowedBrowserOrigin(origin, configuredAllowedOrigins);
}

export function rejectUpgrade(
  socket: UpgradeSocket,
  statusCode: number,
  statusText: string,
  body: string,
): void {
  const payload = Buffer.from(body, 'utf8');
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${payload.byteLength}`,
      '',
      body,
    ].join('\r\n'),
  );
  socket.destroy();
}

interface UpgradeSocket {
  write(chunk: string): boolean;
  destroy(error?: Error): void;
}
