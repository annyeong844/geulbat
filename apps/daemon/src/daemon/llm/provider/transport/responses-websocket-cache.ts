import WebSocket from 'ws';
import type { ResponsesWebSocketEventSource } from './responses-websocket-stream.js';

import {
  closeWebSocketSilently,
  connectWebSocket,
} from './responses-websocket-connection.js';

export interface ResponsesWebSocketReusePolicy {
  readonly idleRetentionMs: number;
  readonly maxConnectionLifetimeMs: number;
}

export interface ResponsesWebSocketSessionSocket extends ResponsesWebSocketEventSource {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface SessionEntry {
  socket: ResponsesWebSocketSessionSocket;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  connectionExpiresAtMs: number;
  reusePolicy: ResponsesWebSocketReusePolicy;
}

interface SocketHandle {
  socket: ResponsesWebSocketSessionSocket;
  readonly reused: boolean;
  release: (options?: { keep?: boolean }) => void;
}

interface ResponsesWebSocketSessionStoreDeps {
  now?: () => number;
  scheduleTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
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
    reusePolicy: ResponsesWebSocketReusePolicy,
    signal?: AbortSignal,
  ): Promise<SocketHandle>;
}

export function createResponsesWebSocketSessionStore(
  deps?: ResponsesWebSocketSessionStoreDeps,
): ResponsesWebSocketSessionStore {
  const websocketSessionCache = new Map<string, SessionEntry>();
  const now = deps?.now ?? Date.now;
  const scheduleTimeout = deps?.scheduleTimeout ?? setTimeout;
  const clearScheduledTimeout = deps?.clearScheduledTimeout ?? clearTimeout;
  const connectWebSocketImpl: NonNullable<
    ResponsesWebSocketSessionStoreDeps['connectWebSocket']
  > = deps?.connectWebSocket ?? connectWebSocket;
  const closeWebSocketSilentlyImpl: NonNullable<
    ResponsesWebSocketSessionStoreDeps['closeWebSocketSilently']
  > = deps?.closeWebSocketSilently ?? closeWebSocketSilently;

  function scheduleSessionWebSocketExpiry(
    cacheKey: string,
    entry: SessionEntry,
  ): void {
    if (entry.idleTimer) {
      clearScheduledTimeout(entry.idleTimer);
    }
    const remainingConnectionLifetimeMs = entry.connectionExpiresAtMs - now();
    if (remainingConnectionLifetimeMs <= 0) {
      closeWebSocketSilentlyImpl(
        entry.socket,
        1000,
        'connection_lifetime_reached',
      );
      websocketSessionCache.delete(cacheKey);
      return;
    }

    const expiresForConnectionLifetime =
      remainingConnectionLifetimeMs <= entry.reusePolicy.idleRetentionMs;
    const delayMs = Math.min(
      entry.reusePolicy.idleRetentionMs,
      remainingConnectionLifetimeMs,
    );
    entry.idleTimer = scheduleTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.busy || websocketSessionCache.get(cacheKey) !== entry) {
        return;
      }
      closeWebSocketSilentlyImpl(
        entry.socket,
        1000,
        expiresForConnectionLifetime
          ? 'connection_lifetime_reached'
          : 'idle_timeout',
      );
      websocketSessionCache.delete(cacheKey);
    }, delayMs);
    entry.idleTimer.unref?.();
  }

  return {
    async acquireWebSocket(
      url,
      headers,
      providerSessionId,
      reusePolicy,
      signal,
    ) {
      const cacheKey = buildSessionCacheKey(providerSessionId, url);
      let cached = websocketSessionCache.get(cacheKey);
      if (
        cached !== undefined &&
        !cached.busy &&
        now() >= cached.connectionExpiresAtMs
      ) {
        if (cached.idleTimer) {
          clearScheduledTimeout(cached.idleTimer);
        }
        closeWebSocketSilentlyImpl(
          cached.socket,
          1000,
          'connection_lifetime_reached',
        );
        websocketSessionCache.delete(cacheKey);
        cached = undefined;
      }
      if (cached) {
        if (cached.idleTimer) {
          clearScheduledTimeout(cached.idleTimer);
          cached.idleTimer = undefined;
        }

        if (!cached.busy && isWebSocketReusable(cached.socket)) {
          cached.busy = true;
          return {
            socket: cached.socket,
            reused: true,
            release: ({ keep } = {}) => {
              if (!keep || !isWebSocketReusable(cached.socket)) {
                closeWebSocketSilentlyImpl(cached.socket);
                websocketSessionCache.delete(cacheKey);
                return;
              }
              cached.busy = false;
              scheduleSessionWebSocketExpiry(cacheKey, cached);
            },
          };
        }

        if (cached.busy) {
          const socket = await connectWebSocketImpl(url, headers, signal);
          return {
            socket,
            reused: false,
            release: () => {
              closeWebSocketSilentlyImpl(socket);
            },
          };
        }

        if (!isWebSocketReusable(cached.socket)) {
          closeWebSocketSilentlyImpl(cached.socket);
          websocketSessionCache.delete(cacheKey);
        }
      }

      const socket = await connectWebSocketImpl(url, headers, signal);
      const connectedAtMs = now();
      const entry: SessionEntry = {
        socket,
        busy: true,
        idleTimer: undefined,
        connectionExpiresAtMs:
          connectedAtMs + reusePolicy.maxConnectionLifetimeMs,
        reusePolicy,
      };
      websocketSessionCache.set(cacheKey, entry);

      return {
        socket,
        reused: false,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(entry.socket)) {
            closeWebSocketSilentlyImpl(entry.socket);
            if (entry.idleTimer) {
              clearScheduledTimeout(entry.idleTimer);
            }
            if (websocketSessionCache.get(cacheKey) === entry) {
              websocketSessionCache.delete(cacheKey);
            }
            return;
          }
          entry.busy = false;
          scheduleSessionWebSocketExpiry(cacheKey, entry);
        },
      };
    },
  };
}

function buildSessionCacheKey(providerSessionId: string, url: string): string {
  return JSON.stringify([providerSessionId, url]);
}

function isWebSocketReusable(socket: ResponsesWebSocketSessionSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}
