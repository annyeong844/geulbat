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

interface TrackedConnection {
  providerScope: string;
  providerSessionId: string;
  temporary: boolean;
  busy: boolean;
}

interface ProviderAdmissionLease {
  release(): void;
}

interface ProviderCooldownWaiter {
  resolve: (lease: ProviderAdmissionLease | undefined) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

interface ProviderCooldownState {
  untilMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  probe: symbol | undefined;
  probeRejected: boolean;
  waiters: Set<ProviderCooldownWaiter>;
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

export interface ResponsesWebSocketPressureScopeSnapshot {
  providerScope: string;
  providerSessionCount: number;
  openSocketCount: number;
  busySocketCount: number;
  temporarySocketCount: number;
  connectingSocketCount: number;
  cooldownRemainingMs: number;
  cooldownWaiterCount: number;
  cooldownProbeActive: boolean;
}

export interface ResponsesWebSocketPressureSnapshot {
  openSocketCount: number;
  busySocketCount: number;
  temporarySocketCount: number;
  connectingSocketCount: number;
  cooldownWaiterCount: number;
  cooldownProbeCount: number;
  peakSocketCount: number;
  scopes: ResponsesWebSocketPressureScopeSnapshot[];
}

export type ResponsesWebSocketAdmissionObservation =
  | { state: 'rate_limit_waiting' }
  | { state: 'admitted' };

export type ResponsesWebSocketAdmissionObserver = (
  observation: ResponsesWebSocketAdmissionObservation,
) => void;

export interface ResponsesWebSocketSessionStore {
  acquireWebSocket(
    url: string,
    headers: Headers,
    providerSessionId: string,
    reusePolicy: ResponsesWebSocketReusePolicy,
    signal?: AbortSignal,
    onAdmissionState?: ResponsesWebSocketAdmissionObserver,
  ): Promise<SocketHandle>;
  deferProviderRequests?(url: string, retryAfterMs: number): void;
}

export interface OwnedResponsesWebSocketSessionStore extends ResponsesWebSocketSessionStore {
  deferProviderRequests(url: string, retryAfterMs: number): void;
  readPressureSnapshot(): ResponsesWebSocketPressureSnapshot;
  closeAll(): Promise<{ ok: true }>;
}

export function createResponsesWebSocketSessionStore(
  deps?: ResponsesWebSocketSessionStoreDeps,
): OwnedResponsesWebSocketSessionStore {
  const websocketSessionCache = new Map<string, SessionEntry>();
  const trackedConnections = new Map<
    ResponsesWebSocketSessionSocket,
    TrackedConnection
  >();
  const connectingByScopeAndSession = new Map<string, number>();
  const cooldownByProviderScope = new Map<string, ProviderCooldownState>();
  const shutdownController = new AbortController();
  let peakSocketCount = 0;
  let closed = false;
  const now = deps?.now ?? Date.now;
  const scheduleTimeout = deps?.scheduleTimeout ?? setTimeout;
  const clearScheduledTimeout = deps?.clearScheduledTimeout ?? clearTimeout;
  const connectWebSocketImpl: NonNullable<
    ResponsesWebSocketSessionStoreDeps['connectWebSocket']
  > = deps?.connectWebSocket ?? connectWebSocket;
  const closeWebSocketSilentlyImpl: NonNullable<
    ResponsesWebSocketSessionStoreDeps['closeWebSocketSilently']
  > = deps?.closeWebSocketSilently ?? closeWebSocketSilently;

  function closeTrackedSocket(
    socket: ResponsesWebSocketSessionSocket,
    code?: number,
    reason?: string,
  ): void {
    trackedConnections.delete(socket);
    closeWebSocketSilentlyImpl(socket, code, reason);
  }

  function trackConnection(args: {
    socket: ResponsesWebSocketSessionSocket;
    providerScope: string;
    providerSessionId: string;
    temporary: boolean;
  }): void {
    trackedConnections.set(args.socket, {
      providerScope: args.providerScope,
      providerSessionId: args.providerSessionId,
      temporary: args.temporary,
      busy: true,
    });
  }

  function readConnectingSocketCount(): number {
    let total = 0;
    for (const count of connectingByScopeAndSession.values()) {
      total += count;
    }
    return total;
  }

  async function connectTrackedWebSocket(args: {
    url: string;
    headers: Headers;
    signal?: AbortSignal;
    providerScope: string;
    providerSessionId: string;
    temporary: boolean;
  }): Promise<ResponsesWebSocketSessionSocket> {
    const connectionKey = buildScopeSessionKey(
      args.providerScope,
      args.providerSessionId,
    );
    connectingByScopeAndSession.set(
      connectionKey,
      (connectingByScopeAndSession.get(connectionKey) ?? 0) + 1,
    );
    peakSocketCount = Math.max(
      peakSocketCount,
      trackedConnections.size + readConnectingSocketCount(),
    );
    try {
      const socket = await connectWebSocketImpl(
        args.url,
        args.headers,
        args.signal,
      );
      if (closed) {
        closeWebSocketSilentlyImpl(socket, 1000, 'daemon_shutdown');
        throw new Error('responses websocket session store is closed');
      }
      trackConnection({
        socket,
        providerScope: args.providerScope,
        providerSessionId: args.providerSessionId,
        temporary: args.temporary,
      });
      return socket;
    } finally {
      const remaining =
        (connectingByScopeAndSession.get(connectionKey) ?? 1) - 1;
      if (remaining > 0) {
        connectingByScopeAndSession.set(connectionKey, remaining);
      } else {
        connectingByScopeAndSession.delete(connectionKey);
      }
    }
  }

  function settleProviderCooldownWaiter(
    waiter: ProviderCooldownWaiter,
    lease: ProviderAdmissionLease | undefined,
  ): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(lease);
  }

  function rejectProviderCooldownWaiter(
    waiter: ProviderCooldownWaiter,
    error: Error,
  ): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.reject(error);
  }

  function createProviderProbeLease(
    providerScope: string,
    state: ProviderCooldownState,
    probe: symbol,
  ): ProviderAdmissionLease {
    let released = false;
    return {
      release() {
        if (released) {
          return;
        }
        released = true;
        if (
          cooldownByProviderScope.get(providerScope) !== state ||
          state.probe !== probe
        ) {
          return;
        }

        state.probe = undefined;
        const probeRejected = state.probeRejected;
        state.probeRejected = false;
        if (probeRejected || state.untilMs > now()) {
          scheduleProviderCooldown(providerScope, state);
          return;
        }

        if (state.timer) {
          clearScheduledTimeout(state.timer);
          state.timer = undefined;
        }
        cooldownByProviderScope.delete(providerScope);
        const waiters = [...state.waiters];
        state.waiters.clear();
        for (const waiter of waiters) {
          settleProviderCooldownWaiter(waiter, undefined);
        }
      },
    };
  }

  function admitNextProviderProbe(
    providerScope: string,
    state: ProviderCooldownState,
  ): void {
    if (
      closed ||
      cooldownByProviderScope.get(providerScope) !== state ||
      state.probe !== undefined
    ) {
      return;
    }
    const next = state.waiters.values().next();
    if (next.done) {
      return;
    }
    const waiter = next.value;
    state.waiters.delete(waiter);
    const probe = Symbol();
    state.probe = probe;
    state.probeRejected = false;
    settleProviderCooldownWaiter(
      waiter,
      createProviderProbeLease(providerScope, state, probe),
    );
  }

  function scheduleProviderCooldown(
    providerScope: string,
    state: ProviderCooldownState,
  ): void {
    if (closed || cooldownByProviderScope.get(providerScope) !== state) {
      return;
    }
    if (state.timer) {
      clearScheduledTimeout(state.timer);
      state.timer = undefined;
    }
    const remainingMs = state.untilMs - now();
    if (remainingMs <= 0) {
      admitNextProviderProbe(providerScope, state);
      return;
    }
    state.timer = scheduleTimeout(() => {
      state.timer = undefined;
      if (closed || cooldownByProviderScope.get(providerScope) !== state) {
        return;
      }
      if (state.untilMs > now()) {
        scheduleProviderCooldown(providerScope, state);
        return;
      }
      admitNextProviderProbe(providerScope, state);
    }, remainingMs);
    state.timer.unref?.();
  }

  function deferProviderScope(
    providerScope: string,
    retryAfterMs: number,
  ): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0 || closed) {
      return;
    }
    let state = cooldownByProviderScope.get(providerScope);
    if (state === undefined) {
      state = {
        untilMs: 0,
        timer: undefined,
        probe: undefined,
        probeRejected: false,
        waiters: new Set(),
      };
      cooldownByProviderScope.set(providerScope, state);
    }
    state.untilMs = Math.max(state.untilMs, now() + retryAfterMs);
    if (state.probe !== undefined) {
      state.probeRejected = true;
    }
    scheduleProviderCooldown(providerScope, state);
  }

  async function waitForProviderAdmission(
    providerScope: string,
    signal?: AbortSignal,
    onAdmissionState?: ResponsesWebSocketAdmissionObserver,
  ): Promise<ProviderAdmissionLease | undefined> {
    if (closed) {
      throw new Error('responses websocket session store is closed');
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('provider cooldown wait aborted');
    }
    const state = cooldownByProviderScope.get(providerScope);
    if (state === undefined) {
      return undefined;
    }
    if (state.untilMs <= now() && state.probe === undefined) {
      const probe = Symbol();
      state.probe = probe;
      state.probeRejected = false;
      return createProviderProbeLease(providerScope, state, probe);
    }

    onAdmissionState?.({ state: 'rate_limit_waiting' });
    return await new Promise<ProviderAdmissionLease | undefined>(
      (resolve, reject) => {
        const waiter: ProviderCooldownWaiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            if (!state.waiters.delete(waiter)) {
              return;
            }
            rejectProviderCooldownWaiter(
              waiter,
              signal?.reason instanceof Error
                ? signal.reason
                : new Error('provider cooldown wait aborted'),
            );
          },
        };
        state.waiters.add(waiter);
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        if (signal?.aborted) {
          waiter.onAbort();
          return;
        }
        if (state.timer === undefined && state.untilMs > now()) {
          scheduleProviderCooldown(providerScope, state);
        }
      },
    );
  }

  function createTemporarySocketHandle(
    socket: ResponsesWebSocketSessionSocket,
  ): SocketHandle {
    const tracked = trackedConnections.get(socket);
    if (tracked) {
      tracked.temporary = true;
    }
    let released = false;
    return {
      socket,
      reused: false,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        closeTrackedSocket(socket);
      },
    };
  }

  function attachProviderAdmission(
    handle: SocketHandle,
    admission: ProviderAdmissionLease | undefined,
  ): SocketHandle {
    if (admission === undefined) {
      return handle;
    }
    return {
      socket: handle.socket,
      reused: handle.reused,
      release(options) {
        try {
          handle.release(options);
        } finally {
          admission.release();
        }
      },
    };
  }

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
      trackedConnections.delete(entry.socket);
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
      trackedConnections.delete(entry.socket);
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
      onAdmissionState,
    ) {
      const acquisitionSignal =
        signal === undefined
          ? shutdownController.signal
          : AbortSignal.any([signal, shutdownController.signal]);
      const providerScope = buildProviderScope(url);
      let waitedForProviderAdmission = false;
      const providerAdmission = await waitForProviderAdmission(
        providerScope,
        acquisitionSignal,
        (observation) => {
          waitedForProviderAdmission = true;
          onAdmissionState?.(observation);
        },
      );
      if (waitedForProviderAdmission) {
        onAdmissionState?.({ state: 'admitted' });
      }
      try {
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
          trackedConnections.delete(cached.socket);
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
            const tracked = trackedConnections.get(cached.socket);
            if (tracked) {
              tracked.busy = true;
            }
            let released = false;
            return attachProviderAdmission(
              {
                socket: cached.socket,
                reused: true,
                release: ({ keep } = {}) => {
                  if (released) {
                    return;
                  }
                  released = true;
                  if (!keep || !isWebSocketReusable(cached.socket)) {
                    closeTrackedSocket(cached.socket);
                    websocketSessionCache.delete(cacheKey);
                    return;
                  }
                  cached.busy = false;
                  const retained = trackedConnections.get(cached.socket);
                  if (retained) {
                    retained.busy = false;
                  }
                  scheduleSessionWebSocketExpiry(cacheKey, cached);
                },
              },
              providerAdmission,
            );
          }

          if (cached.busy) {
            const socket = await connectTrackedWebSocket({
              url,
              headers,
              signal: acquisitionSignal,
              providerScope,
              providerSessionId,
              temporary: true,
            });
            return attachProviderAdmission(
              createTemporarySocketHandle(socket),
              providerAdmission,
            );
          }

          if (!isWebSocketReusable(cached.socket)) {
            closeTrackedSocket(cached.socket);
            websocketSessionCache.delete(cacheKey);
          }
        }

        const socket = await connectTrackedWebSocket({
          url,
          headers,
          signal: acquisitionSignal,
          providerScope,
          providerSessionId,
          temporary: false,
        });
        if (websocketSessionCache.has(cacheKey)) {
          return attachProviderAdmission(
            createTemporarySocketHandle(socket),
            providerAdmission,
          );
        }
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

        let released = false;
        return attachProviderAdmission(
          {
            socket,
            reused: false,
            release: ({ keep } = {}) => {
              if (released) {
                return;
              }
              released = true;
              if (!keep || !isWebSocketReusable(entry.socket)) {
                closeTrackedSocket(entry.socket);
                if (entry.idleTimer) {
                  clearScheduledTimeout(entry.idleTimer);
                }
                if (websocketSessionCache.get(cacheKey) === entry) {
                  websocketSessionCache.delete(cacheKey);
                }
                return;
              }
              entry.busy = false;
              const retained = trackedConnections.get(entry.socket);
              if (retained) {
                retained.busy = false;
              }
              scheduleSessionWebSocketExpiry(cacheKey, entry);
            },
          },
          providerAdmission,
        );
      } catch (error: unknown) {
        const retryAfterMs = readRetryAfterMs(error);
        if (retryAfterMs !== undefined) {
          deferProviderScope(providerScope, retryAfterMs);
        }
        providerAdmission?.release();
        throw error;
      }
    },
    deferProviderRequests(url, retryAfterMs) {
      deferProviderScope(buildProviderScope(url), retryAfterMs);
    },
    readPressureSnapshot() {
      return buildPressureSnapshot({
        trackedConnections,
        connectingByScopeAndSession,
        cooldownByProviderScope,
        nowMs: now(),
        peakSocketCount,
      });
    },
    async closeAll() {
      closed = true;
      shutdownController.abort(
        new Error('responses websocket session store is closed'),
      );
      for (const entry of websocketSessionCache.values()) {
        if (entry.idleTimer) {
          clearScheduledTimeout(entry.idleTimer);
        }
      }
      websocketSessionCache.clear();
      const storeClosedError = new Error(
        'responses websocket session store is closed',
      );
      for (const state of cooldownByProviderScope.values()) {
        if (state.timer) {
          clearScheduledTimeout(state.timer);
          state.timer = undefined;
        }
        const waiters = [...state.waiters];
        state.waiters.clear();
        for (const waiter of waiters) {
          rejectProviderCooldownWaiter(waiter, storeClosedError);
        }
      }
      cooldownByProviderScope.clear();
      for (const socket of trackedConnections.keys()) {
        closeTrackedSocket(socket, 1000, 'daemon_shutdown');
      }
      return { ok: true };
    },
  };
}

function buildSessionCacheKey(providerSessionId: string, url: string): string {
  return JSON.stringify([providerSessionId, url]);
}

function buildProviderScope(url: string): string {
  return new URL(url).origin;
}

function buildScopeSessionKey(
  providerScope: string,
  providerSessionId: string,
): string {
  return JSON.stringify([providerScope, providerSessionId]);
}

function buildPressureSnapshot(args: {
  trackedConnections: ReadonlyMap<
    ResponsesWebSocketSessionSocket,
    TrackedConnection
  >;
  connectingByScopeAndSession: ReadonlyMap<string, number>;
  cooldownByProviderScope: ReadonlyMap<string, ProviderCooldownState>;
  nowMs: number;
  peakSocketCount: number;
}): ResponsesWebSocketPressureSnapshot {
  const scopes = new Map<
    string,
    {
      providerSessions: Set<string>;
      openSocketCount: number;
      busySocketCount: number;
      temporarySocketCount: number;
      connectingSocketCount: number;
    }
  >();
  const readScope = (providerScope: string) => {
    const existing = scopes.get(providerScope);
    if (existing) {
      return existing;
    }
    const created = {
      providerSessions: new Set<string>(),
      openSocketCount: 0,
      busySocketCount: 0,
      temporarySocketCount: 0,
      connectingSocketCount: 0,
    };
    scopes.set(providerScope, created);
    return created;
  };

  for (const connection of args.trackedConnections.values()) {
    const scope = readScope(connection.providerScope);
    scope.providerSessions.add(connection.providerSessionId);
    scope.openSocketCount += 1;
    scope.busySocketCount += connection.busy ? 1 : 0;
    scope.temporarySocketCount += connection.temporary ? 1 : 0;
  }
  for (const [key, count] of args.connectingByScopeAndSession) {
    const [providerScope, providerSessionId] = JSON.parse(key) as [
      string,
      string,
    ];
    const scope = readScope(providerScope);
    scope.providerSessions.add(providerSessionId);
    scope.connectingSocketCount += count;
  }
  for (const providerScope of args.cooldownByProviderScope.keys()) {
    readScope(providerScope);
  }

  const scopeSnapshots = [...scopes.entries()]
    .map(([providerScope, scope]) => {
      const cooldown = args.cooldownByProviderScope.get(providerScope);
      return {
        providerScope,
        providerSessionCount: scope.providerSessions.size,
        openSocketCount: scope.openSocketCount,
        busySocketCount: scope.busySocketCount,
        temporarySocketCount: scope.temporarySocketCount,
        connectingSocketCount: scope.connectingSocketCount,
        cooldownRemainingMs: Math.max(
          0,
          (cooldown?.untilMs ?? args.nowMs) - args.nowMs,
        ),
        cooldownWaiterCount: cooldown?.waiters.size ?? 0,
        cooldownProbeActive: cooldown?.probe !== undefined,
      };
    })
    .sort((left, right) =>
      left.providerScope.localeCompare(right.providerScope),
    );

  return {
    openSocketCount: [...args.trackedConnections.values()].length,
    busySocketCount: [...args.trackedConnections.values()].filter(
      (connection) => connection.busy,
    ).length,
    temporarySocketCount: [...args.trackedConnections.values()].filter(
      (connection) => connection.temporary,
    ).length,
    connectingSocketCount: [
      ...args.connectingByScopeAndSession.values(),
    ].reduce((total, count) => total + count, 0),
    cooldownWaiterCount: [...args.cooldownByProviderScope.values()].reduce(
      (total, state) => total + state.waiters.size,
      0,
    ),
    cooldownProbeCount: [...args.cooldownByProviderScope.values()].filter(
      (state) => state.probe !== undefined,
    ).length,
    peakSocketCount: args.peakSocketCount,
    scopes: scopeSnapshots,
  };
}

export function readRetryAfterMs(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  const value: unknown = Reflect.get(error, 'retryAfterMs');
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isWebSocketReusable(socket: ResponsesWebSocketSessionSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}
