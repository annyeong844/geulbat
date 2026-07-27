import type { IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import WebSocket from 'ws';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type {
  RunEvent,
  ToolOutputDeltaEventPayload,
} from '@geulbat/protocol/run-events';
import type { ThreadId } from '@geulbat/protocol/ids';

import type { RunEventAgentEvent } from '../../../daemon/runtime-contracts.js';
import { mapAgentEventToRunEvent } from '../protocol/map-events.js';
import {
  isAllowedBrowserOrigin,
  readRequestSelfOrigin,
} from '#web/origin-policy.js';

const WS_POLICY_VIOLATION_CLOSE_CODE = 1008;

/**
 * Byte ceiling for a socket's unflushed send queue before droppable frames stop
 * being written.
 *
 * `socket.send()` returns as soon as the frame is queued, so a browser that
 * stops reading leaves the queue growing inside this process. Measured on a
 * non-consuming client: the queue stays at zero until the OS socket buffer
 * fills, then grows linearly with no ceiling — 8,000 two-kilobyte deltas left
 * 14.8 MB resident.
 *
 * This is a transport limit at the browser socket boundary, not a product
 * policy. It only gates frames the live-run event owner already declares
 * droppable, and the full output stays reachable through its durable
 * `outputRef`, so nothing a user asked for is lost by refusing to queue more.
 */
const WS_DROPPABLE_SEND_BUFFER_LIMIT_BYTES = 1024 * 1024;

const transportLogger = createLogger('run-channel/transport');

/**
 * Sockets currently refusing droppable frames.
 *
 * Recorded so the diagnostic fires on the transition into and out of dropping
 * rather than once per frame. A backed-up socket drops thousands of deltas, and
 * a per-frame log would bury the signal it is supposed to give.
 */
const droppingSockets = new WeakSet<WebSocket>();

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

/**
 * Send a frame the caller is allowed to drop.
 *
 * Durable events must keep using `sendMessage()`: an undelivered durable event
 * becomes `buffered` and the journal replays it on reconnect, so refusing to
 * queue one would break that contract instead of protecting memory.
 */
function sendDroppableMessage(
  socket: WebSocket,
  message: RunChannelServerMessage,
): boolean {
  const buffered = socket.bufferedAmount;
  if (buffered > WS_DROPPABLE_SEND_BUFFER_LIMIT_BYTES) {
    if (!droppingSockets.has(socket)) {
      droppingSockets.add(socket);
      transportLogger
        .withContext({
          diagnosticCode: 'run_channel.droppable_frames_dropped',
          bufferedBytes: buffered,
          limitBytes: WS_DROPPABLE_SEND_BUFFER_LIMIT_BYTES,
        })
        .warn(
          'client is not draining the run channel; dropping streaming frames until it catches up',
        );
    }
    return false;
  }
  if (droppingSockets.has(socket)) {
    droppingSockets.delete(socket);
    transportLogger
      .withContext({
        diagnosticCode: 'run_channel.droppable_frames_resumed',
        bufferedBytes: buffered,
      })
      .info('run channel drained; resuming streaming frames');
  }
  return sendMessage(socket, message);
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
  agentEvent: RunEventAgentEvent,
): boolean {
  const event = mapAgentEventToRunEvent(runId, threadId, seq, agentEvent);
  return sendMessage(socket, { type: 'run.event', event });
}

export function sendToolOutputDelta(
  socket: WebSocket,
  runId: RunEvent['runId'],
  threadId: ThreadId,
  payload: ToolOutputDeltaEventPayload,
): boolean {
  return sendDroppableMessage(socket, {
    type: 'run.tool.output.delta',
    runId,
    threadId,
    payload,
  });
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

/**
 * 판정에 필요한 두 값(`Origin`, `Host`)이 모두 요청에 있으므로 요청을 받는다.
 * 호출부가 origin만 뽑아 넘기면 비교 대상인 self origin을 각자 다시 만들어야
 * 하고, 그러면 표면마다 기준이 갈라질 수 있다.
 */
export function isAllowedWebSocketOrigin(
  req: IncomingMessage,
  configuredAllowedOrigins: ReadonlySet<string>,
): boolean {
  const origin =
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  return isAllowedBrowserOrigin(
    origin,
    configuredAllowedOrigins,
    readRequestSelfOrigin(req.headers.host),
  );
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
