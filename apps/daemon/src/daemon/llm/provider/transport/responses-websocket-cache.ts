import WebSocket from 'ws';
import type { ResponsesWebSocketEventSource } from './responses-websocket-stream.js';

import {
  closeWebSocketSilently,
  connectWebSocket,
} from './responses-websocket-connection.js';

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ResponsesWebSocketSessionSocket extends ResponsesWebSocketEventSource {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface SessionEntry {
  socket: ResponsesWebSocketSessionSocket;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface SocketHandle {
  socket: ResponsesWebSocketSessionSocket;
  entry: SessionEntry;
  release: (options?: { keep?: boolean }) => void;
}

interface ResponsesWebSocketSessionStoreDeps {
  ttlMs?: number;
  connectWebSocket?: (
    url: string,
    headers: Headers,
    signal?: AbortSignal,
  ) => Promise<ResponsesWebSocketSessionSocket>;
  closeWebSocketSilently?: (
    socket: ResponsesWebSocketSessionSocket,
    code?: number,
    reason?: string,
  ) => void;
}

export interface ResponsesWebSocketSessionStore {
  acquireWebSocket(
    url: string,
    headers: Headers,
    providerSessionId: string,
    signal?: AbortSignal,
  ): Promise<SocketHandle>;
}

export function createResponsesWebSocketSessionStore(
  deps?: ResponsesWebSocketSessionStoreDeps,
): ResponsesWebSocketSessionStore {
  const websocketSessionCache = new Map<string, SessionEntry>();
  const ttlMs = deps?.ttlMs ?? SESSION_WEBSOCKET_CACHE_TTL_MS;
  const connectWebSocketImpl: NonNullable<
    ResponsesWebSocketSessionStoreDeps['connectWebSocket']
  > = deps?.connectWebSocket ?? connectWebSocket;
  const closeWebSocketSilentlyImpl: NonNullable<
    ResponsesWebSocketSessionStoreDeps['closeWebSocketSilently']
  > = deps?.closeWebSocketSilently ?? closeWebSocketSilently;

  return {
    async acquireWebSocket(url, headers, providerSessionId, signal) {
      const cached = websocketSessionCache.get(providerSessionId);
      if (cached) {
        if (cached.idleTimer) {
          clearTimeout(cached.idleTimer);
          cached.idleTimer = undefined;
        }

        if (!cached.busy && isWebSocketReusable(cached.socket)) {
          cached.busy = true;
          return {
            socket: cached.socket,
            entry: cached,
            release: ({ keep } = {}) => {
              if (!keep || !isWebSocketReusable(cached.socket)) {
                closeWebSocketSilentlyImpl(cached.socket);
                websocketSessionCache.delete(providerSessionId);
                return;
              }
              cached.busy = false;
              scheduleSessionWebSocketExpiry(
                providerSessionId,
                cached,
                websocketSessionCache,
                closeWebSocketSilentlyImpl,
                ttlMs,
              );
            },
          };
        }

        if (cached.busy) {
          const socket = await connectWebSocketImpl(url, headers, signal);
          return {
            socket,
            entry: { socket, busy: true, idleTimer: undefined },
            release: () => {
              closeWebSocketSilentlyImpl(socket);
            },
          };
        }

        if (!isWebSocketReusable(cached.socket)) {
          closeWebSocketSilentlyImpl(cached.socket);
          websocketSessionCache.delete(providerSessionId);
        }
      }

      const socket = await connectWebSocketImpl(url, headers, signal);
      const entry: SessionEntry = {
        socket,
        busy: true,
        idleTimer: undefined,
      };
      websocketSessionCache.set(providerSessionId, entry);

      return {
        socket,
        entry,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(entry.socket)) {
            closeWebSocketSilentlyImpl(entry.socket);
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            if (websocketSessionCache.get(providerSessionId) === entry) {
              websocketSessionCache.delete(providerSessionId);
            }
            return;
          }
          entry.busy = false;
          scheduleSessionWebSocketExpiry(
            providerSessionId,
            entry,
            websocketSessionCache,
            closeWebSocketSilentlyImpl,
            ttlMs,
          );
        },
      };
    },
  };
}

function isWebSocketReusable(socket: ResponsesWebSocketSessionSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function scheduleSessionWebSocketExpiry(
  providerSessionId: string,
  entry: SessionEntry,
  websocketSessionCache: Map<string, SessionEntry>,
  closeWebSocketSilentlyImpl: (
    socket: ResponsesWebSocketSessionSocket,
    code?: number,
    reason?: string,
  ) => void,
  ttlMs: number,
): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeWebSocketSilentlyImpl(entry.socket, 1000, 'idle_timeout');
    websocketSessionCache.delete(providerSessionId);
  }, ttlMs);
  entry.idleTimer.unref?.();
}
