import { tryParseJsonRecord } from '../../../runtime-json.js';
import type WebSocket from 'ws';

import { getErrorMessage } from '../../../utils/error.js';
import {
  extractWebSocketCloseError,
  extractWebSocketError,
} from './responses-websocket-errors.js';

export interface ResponsesWebSocketEventSource {
  on(event: 'message', listener: (data: WebSocket.RawData) => void): void;
  on(event: 'error', listener: (event: unknown) => void): void;
  on(event: 'close', listener: (event: unknown) => void): void;
  off(event: 'message', listener: (data: WebSocket.RawData) => void): void;
  off(event: 'error', listener: (event: unknown) => void): void;
  off(event: 'close', listener: (event: unknown) => void): void;
}

export async function* iterateWebSocketEvents(
  socket: ResponsesWebSocketEventSource,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;
  let closeEvent: unknown = null;
  let pendingDecodes = 0;
  let decodeChain = Promise.resolve();

  const wake = () => {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    resolve();
  };

  const finalizeIfReady = () => {
    if (pendingDecodes > 0) {
      return;
    }
    if (failed) {
      done = true;
      wake();
      return;
    }
    if (sawCompletion) {
      done = true;
      wake();
      return;
    }
    if (closeEvent) {
      failed = extractWebSocketCloseError(closeEvent);
      done = true;
      wake();
    }
  };

  const onMessage = (data: WebSocket.RawData) => {
    pendingDecodes += 1;
    decodeChain = decodeChain
      .then(async () => {
        if (failed) {
          return;
        }
        const text = await decodeWebSocketData(data);
        if (!text) return;
        const parsed = tryParseJsonRecord(text);
        if (!parsed.ok) {
          failed = new Error(
            'invalid provider websocket frame: expected JSON object',
          );
          return;
        }
        const type =
          typeof parsed.value.type === 'string' ? parsed.value.type : '';
        if (type === 'response.completed' || type === 'response.done') {
          sawCompletion = true;
        }
        queue.push(parsed.value);
        wake();
      })
      .catch((error: unknown) => {
        failed = new Error(
          `invalid provider websocket frame: ${getErrorMessage(error)}`,
        );
      })
      .finally(() => {
        pendingDecodes -= 1;
        finalizeIfReady();
        wake();
      });
  };

  const onError = (event: unknown) => {
    failed = extractWebSocketError(event);
    finalizeIfReady();
  };

  const onClose = (event: unknown) => {
    closeEvent = event;
    finalizeIfReady();
  };

  const onAbort = () => {
    failed = new Error('Request was aborted');
    finalizeIfReady();
  };

  socket.on('message', onMessage);
  socket.on('error', onError);
  socket.on('close', onClose);
  signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request was aborted');
      }
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }
    if (failed) throw failed;
    if (!sawCompletion) {
      throw new Error('WebSocket stream closed before response.completed');
    }
  } finally {
    socket.off('message', onMessage);
    socket.off('error', onError);
    socket.off('close', onClose);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (data && typeof data === 'object' && 'arrayBuffer' in data) {
    const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
    return new TextDecoder().decode(
      new Uint8Array(await blobLike.arrayBuffer()),
    );
  }
  return null;
}
