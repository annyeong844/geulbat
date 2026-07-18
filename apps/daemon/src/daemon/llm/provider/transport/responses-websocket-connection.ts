import WebSocket from 'ws';

import { getErrorMessage } from '../../../utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
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
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
