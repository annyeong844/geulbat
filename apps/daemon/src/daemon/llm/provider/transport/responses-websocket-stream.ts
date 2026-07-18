import { isRecord, tryParseJsonRecord } from '../../../runtime-json.js';
import type WebSocket from 'ws';

import { getErrorMessage } from '../../../utils/error.js';
import {
  extractWebSocketCloseError,
  extractWebSocketError,
} from './responses-websocket-errors.js';

const DEFAULT_COMPLETION_EVENT_TYPES = [
  'response.completed',
  'response.done',
] as const;

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
  completionEventTypes: readonly string[] = DEFAULT_COMPLETION_EVENT_TYPES,
): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  const failureState: { current: Error | null } = { current: null };
  let sawCompletion = false;
  let closeEvent: unknown = null;
  let pendingDecodes = 0;
  let decodeChain = Promise.resolve();

  const wake = () => {
    if (!pending) {
      return;
    }
    const resolve = pending;
    pending = null;
    resolve();
  };

  const finalizeIfReady = () => {
    if (pendingDecodes > 0) {
      return;
    }
    if (failureState.current) {
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
      failureState.current = extractWebSocketCloseError(closeEvent);
      done = true;
      wake();
    }
  };

  const onMessage = (data: WebSocket.RawData) => {
    pendingDecodes += 1;
    decodeChain = decodeChain
      .then(async () => {
        if (failureState.current) {
          return;
        }
        const text = await decodeWebSocketData(data);
        if (!text) {
          return;
        }
        const parsed = tryParseJsonRecord(text);
        if (!parsed.ok) {
          failureState.current = new Error(
            'invalid provider websocket frame: expected JSON object',
          );
          return;
        }
        const type =
          typeof parsed.value.type === 'string' ? parsed.value.type : '';
        if (completionEventTypes.includes(type)) {
          sawCompletion = true;
        }
        queue.push(parsed.value);
        wake();
      })
      .catch((error: unknown) => {
        failureState.current = new Error(
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
    failureState.current = extractWebSocketError(event);
    finalizeIfReady();
  };

  const onClose = (event: unknown) => {
    closeEvent = event;
    finalizeIfReady();
  };

  const onAbort = () => {
    failureState.current = new Error('Request was aborted');
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
      if (done) {
        break;
      }
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }
    const failure = failureState.current;
    if (failure) {
      throw failure;
    }
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
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (isRecord(data) && 'arrayBuffer' in data) {
    if (!hasArrayBufferMethod(data)) {
      throw new TypeError('arrayBuffer is not callable');
    }
    const arrayBuffer = await data.arrayBuffer();
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      throw new TypeError('arrayBuffer() did not return an ArrayBuffer');
    }
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}

function hasArrayBufferMethod(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { arrayBuffer: () => unknown } {
  return typeof value.arrayBuffer === 'function';
}
