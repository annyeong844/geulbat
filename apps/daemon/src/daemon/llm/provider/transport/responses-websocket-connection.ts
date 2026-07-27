import type { ClientRequest, IncomingMessage } from 'node:http';
import WebSocket from 'ws';

import { getErrorMessage } from '../../../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import {
  extractWebSocketCloseError,
  extractWebSocketError,
} from './responses-websocket-errors.js';

const WS_CONNECT_TIMEOUT_MS = 30_000;
const logger = createLogger('responses-ws');

interface CloseableWebSocket {
  close(code?: number, reason?: string): void;
}

export function closeWebSocketSilently(
  socket: CloseableWebSocket,
  code = 1000,
  reason = 'done',
): void {
  try {
    socket.close(code, reason);
  } catch (error: unknown) {
    logger.warn('socket close failed:', getErrorMessage(error));
  }
}

export async function connectWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<WebSocket> {
  const wsHeaders = headersToRecord(headers);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket;

    try {
      socket = new WebSocket(url, {
        headers: wsHeaders,
        handshakeTimeout: WS_CONNECT_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      reject(
        error instanceof Error ? error : new Error(getErrorMessage(error)),
      );
      return;
    }

    const onOpen = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };

    const onError = (event: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(extractWebSocketError(event));
    };

    const onClose = (event: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(extractWebSocketCloseError(event));
    };

    const onUnexpectedResponse = (
      _request: ClientRequest,
      response: IncomingMessage,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      response.resume();
      reject(createUnexpectedResponseError(response));
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      closeWebSocketSilently(socket, 1000, 'aborted');
      reject(new Error('Request was aborted'));
    };

    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('unexpected-response', onUnexpectedResponse);
      signal?.removeEventListener('abort', onAbort);
    };

    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      closeWebSocketSilently(socket, 1000, 'connect_timeout');
      reject(
        Object.assign(new Error('LLM connect timeout'), {
          llmCode: 'llm_connect_timeout',
        }),
      );
    }, WS_CONNECT_TIMEOUT_MS);

    socket.on('open', onOpen);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('unexpected-response', onUnexpectedResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createUnexpectedResponseError(response: IncomingMessage): Error {
  const status = response.statusCode;
  const retryAfterMs = parseRetryAfterMs(
    response.headers['retry-after'],
    Date.now(),
  );
  return Object.assign(
    new Error(
      status === undefined
        ? 'WebSocket upgrade rejected'
        : `Unexpected server response: ${status}`,
    ),
    {
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

export function parseRetryAfterMs(
  value: string | string[] | undefined,
  nowMs: number,
): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) {
    return undefined;
  }
  const seconds = Number(candidate);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const retryAtMs = Date.parse(candidate);
  if (!Number.isFinite(retryAtMs)) {
    return undefined;
  }
  return Math.max(0, retryAtMs - nowMs);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
