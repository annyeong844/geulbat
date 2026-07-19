import {
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../../utils/error.js';

function createWebSocketConnectionError(message: string): Error {
  return Object.assign(new Error(message), {
    llmCode: 'llm_connection_lost' as const,
  });
}

export function extractWebSocketError(event: unknown): Error {
  if (event instanceof Error && event.message) {
    return createWebSocketConnectionError(event.message);
  }
  if (event && typeof event === 'object' && 'message' in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return createWebSocketConnectionError(message);
    }
  }
  return createWebSocketConnectionError('WebSocket error');
}

export function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === 'object') {
    const code = getErrorNumberProperty(event, 'code');
    const reason: unknown =
      getErrorStringProperty(event, 'reason') ?? Reflect.get(event, 'reason');
    const codeText = typeof code === 'number' ? ` ${code}` : '';
    const reasonText =
      typeof reason === 'string'
        ? reason.length > 0
          ? ` ${reason}`
          : ''
        : reason instanceof Uint8Array
          ? ` ${new TextDecoder().decode(reason)}`
          : '';
    return createWebSocketConnectionError(
      `WebSocket closed${codeText}${reasonText}`.trim(),
    );
  }
  return createWebSocketConnectionError('WebSocket closed');
}
