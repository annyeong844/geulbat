import {
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../../utils/error.js';

export function extractWebSocketError(event: unknown): Error {
  if (event instanceof Error && event.message) {
    return event;
  }
  if (event && typeof event === 'object' && 'message' in event) {
    const message = (event as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return new Error(message);
    }
  }
  return new Error('WebSocket error');
}

export function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === 'object') {
    const code = getErrorNumberProperty(event, 'code');
    const reason =
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
    return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
  }
  return new Error('WebSocket closed');
}
