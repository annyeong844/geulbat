import test from 'node:test';
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import {
  createResponsesWebSocketSessionStore,
  type ResponsesWebSocketReusePolicy,
  type ResponsesWebSocketSessionSocket,
} from './responses-websocket-cache.js';

const TEST_REUSE_POLICY = {
  idleRetentionMs: 50,
  maxConnectionLifetimeMs: 500,
} as const satisfies ResponsesWebSocketReusePolicy;

function createFakeSocket(): ResponsesWebSocketSessionSocket {
  const socket: ResponsesWebSocketSessionSocket = {
    readyState: WebSocket.OPEN,
    send() {
      return;
    },
    on() {
      return;
    },
    off() {
      return;
    },
    close() {
      socket.readyState = WebSocket.CLOSED;
    },
  };

  return socket;
}

void test('responses websocket session store reuses an idle socket within one store', async () => {
  let connectCalls = 0;
  const store = createResponsesWebSocketSessionStore({
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
  });

  const first = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  first.release({ keep: true });

  const second = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.socket, first.socket);
  assert.equal(connectCalls, 1);

  second.release({ keep: false });
});

void test('responses websocket session store separates cached sockets by provider route URL', async () => {
  let connectCalls = 0;
  const store = createResponsesWebSocketSessionStore({
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
  });

  const codex = await store.acquireWebSocket(
    'wss://chatgpt.test/backend-api/codex/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  codex.release({ keep: true });

  const grok = await store.acquireWebSocket(
    'wss://api.x.ai/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );

  assert.notEqual(grok.socket, codex.socket);
  assert.equal(connectCalls, 2);

  grok.release({ keep: false });
  codex.release({ keep: false });
});

void test('responses websocket session stores isolate session caches per instance', async () => {
  let connectCalls = 0;
  const connectWebSocket = async () => {
    connectCalls += 1;
    return createFakeSocket();
  };
  const first = createResponsesWebSocketSessionStore({ connectWebSocket });
  const second = createResponsesWebSocketSessionStore({ connectWebSocket });

  const firstHandle = await first.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  const secondHandle = await second.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );

  assert.notEqual(firstHandle.socket, secondHandle.socket);
  assert.equal(connectCalls, 2);

  firstHandle.release({ keep: false });
  secondHandle.release({ keep: false });
});

void test('responses websocket reuse expires the stale socket and reconnects on the next acquire', async () => {
  let nowMs = 0;
  let connectCalls = 0;
  const closeReasons: string[] = [];
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const store = createResponsesWebSocketSessionStore({
    now: () => nowMs,
    scheduleTimeout(callback, delayMs) {
      const handle = setTimeout(() => {}, 60_000);
      handle.unref();
      scheduled.push({ callback, delayMs, handle });
      return handle;
    },
    clearScheduledTimeout: clearTimeout,
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
    closeWebSocketSilently(_socket, _code, reason) {
      if (reason !== undefined) {
        closeReasons.push(reason);
      }
    },
  });
  const policy = {
    idleRetentionMs: 30,
    maxConnectionLifetimeMs: 60,
  } as const satisfies ResponsesWebSocketReusePolicy;

  const first = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    policy,
  );
  first.release({ keep: true });
  assert.equal(scheduled.at(-1)?.delayMs, 30);

  nowMs = 20;
  const second = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    policy,
  );
  assert.equal(second.socket, first.socket);
  second.release({ keep: true });
  assert.equal(scheduled.at(-1)?.delayMs, 30);

  nowMs = 50;
  const third = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    policy,
  );
  assert.equal(third.socket, first.socket);
  third.release({ keep: true });
  assert.equal(scheduled.at(-1)?.delayMs, 10);

  scheduled.at(-1)?.callback();
  assert.deepEqual(closeReasons, ['connection_lifetime_reached']);

  nowMs = 61;
  const replacement = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
    policy,
  );
  assert.notEqual(replacement.socket, first.socket);
  assert.equal(connectCalls, 2);
  replacement.release({ keep: false });

  for (const item of scheduled) {
    clearTimeout(item.handle);
  }
});

void test('responses websocket session owner observes cached and temporary fan-out and closes every socket', async () => {
  const sockets: ResponsesWebSocketSessionSocket[] = [];
  const store = createResponsesWebSocketSessionStore({
    async connectWebSocket() {
      const socket = createFakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const cached = await store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'thread-a',
    TEST_REUSE_POLICY,
  );
  const temporary = await store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'thread-a',
    TEST_REUSE_POLICY,
  );
  const otherProvider = await store.acquireWebSocket(
    'wss://api.other.test/v1/responses',
    new Headers(),
    'thread-b',
    TEST_REUSE_POLICY,
  );

  assert.deepEqual(store.readPressureSnapshot(), {
    openSocketCount: 3,
    busySocketCount: 3,
    temporarySocketCount: 1,
    connectingSocketCount: 0,
    cooldownWaiterCount: 0,
    cooldownProbeCount: 0,
    peakSocketCount: 3,
    scopes: [
      {
        providerScope: 'wss://api.example.test',
        providerSessionCount: 1,
        openSocketCount: 2,
        busySocketCount: 2,
        temporarySocketCount: 1,
        connectingSocketCount: 0,
        cooldownRemainingMs: 0,
        cooldownWaiterCount: 0,
        cooldownProbeActive: false,
      },
      {
        providerScope: 'wss://api.other.test',
        providerSessionCount: 1,
        openSocketCount: 1,
        busySocketCount: 1,
        temporarySocketCount: 0,
        connectingSocketCount: 0,
        cooldownRemainingMs: 0,
        cooldownWaiterCount: 0,
        cooldownProbeActive: false,
      },
    ],
  });

  cached.release({ keep: true });
  temporary.release();
  assert.deepEqual(
    {
      openSocketCount: store.readPressureSnapshot().openSocketCount,
      busySocketCount: store.readPressureSnapshot().busySocketCount,
      temporarySocketCount: store.readPressureSnapshot().temporarySocketCount,
    },
    { openSocketCount: 2, busySocketCount: 1, temporarySocketCount: 0 },
  );

  await store.closeAll();
  assert.equal(store.readPressureSnapshot().openSocketCount, 0);
  assert.equal(
    sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
    true,
  );
  otherProvider.release({ keep: true });
  await assert.rejects(
    store.acquireWebSocket(
      'wss://api.example.test/v1/responses',
      new Headers(),
      'thread-c',
      TEST_REUSE_POLICY,
    ),
    /session store is closed/u,
  );
});

void test('concurrent cold acquisitions keep one canonical cached socket and release the raced socket as temporary', async () => {
  const pendingConnections: Array<{
    resolve: (socket: ResponsesWebSocketSessionSocket) => void;
    socket: ResponsesWebSocketSessionSocket;
  }> = [];
  let resolveBothPending: (() => void) | undefined;
  const bothPending = new Promise<void>((resolve) => {
    resolveBothPending = resolve;
  });
  const store = createResponsesWebSocketSessionStore({
    connectWebSocket() {
      const socket = createFakeSocket();
      return new Promise<ResponsesWebSocketSessionSocket>((resolve) => {
        pendingConnections.push({ resolve, socket });
        if (pendingConnections.length === 2) {
          resolveBothPending?.();
        }
      });
    },
  });

  const firstPromise = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  const racedPromise = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );

  await bothPending;
  assert.equal(pendingConnections.length, 2);
  const firstPending = pendingConnections[0];
  assert.ok(firstPending);
  firstPending.resolve(firstPending.socket);
  const first = await firstPromise;
  const racedPending = pendingConnections[1];
  assert.ok(racedPending);
  racedPending.resolve(racedPending.socket);
  const raced = await racedPromise;

  assert.deepEqual(
    {
      openSocketCount: store.readPressureSnapshot().openSocketCount,
      temporarySocketCount: store.readPressureSnapshot().temporarySocketCount,
    },
    { openSocketCount: 2, temporarySocketCount: 1 },
  );

  first.release({ keep: true });
  raced.release({ keep: true });
  assert.equal(raced.socket.readyState, WebSocket.CLOSED);
  assert.deepEqual(
    {
      openSocketCount: store.readPressureSnapshot().openSocketCount,
      temporarySocketCount: store.readPressureSnapshot().temporarySocketCount,
    },
    { openSocketCount: 1, temporarySocketCount: 0 },
  );

  const reused = await store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  assert.equal(reused.reused, true);
  assert.equal(reused.socket, first.socket);

  reused.release();
  await store.closeAll();
});

void test('responses websocket session owner aborts pending provider cooldown admission on shutdown', async () => {
  let scheduledCallback: (() => void) | undefined;
  let scheduledHandle: ReturnType<typeof setTimeout> | undefined;
  let clearCalls = 0;
  let resolveScheduled: (() => void) | undefined;
  const scheduled = new Promise<void>((resolve) => {
    resolveScheduled = resolve;
  });
  const store = createResponsesWebSocketSessionStore({
    scheduleTimeout(callback) {
      scheduledCallback = callback;
      scheduledHandle = setTimeout(() => {}, 60_000);
      scheduledHandle.unref();
      resolveScheduled?.();
      return scheduledHandle;
    },
    clearScheduledTimeout(handle) {
      clearCalls += 1;
      clearTimeout(handle);
    },
    async connectWebSocket() {
      throw new Error('cooldown admission must settle before connecting');
    },
  });

  store.deferProviderRequests('wss://api.example.test/v1/responses', 60_000);
  const pending = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  await scheduled;

  await store.closeAll();
  const clearedOnShutdown = clearCalls > 0;
  if (!clearedOnShutdown) {
    scheduledCallback?.();
  }
  await assert.rejects(pending, /session store is closed/u);
  assert.equal(clearedOnShutdown, true);
});

void test('provider cooldown admission reports its wait and removes a cancelled waiter without connecting', async () => {
  const observations: string[] = [];
  const controller = new AbortController();
  let connectCalls = 0;
  const store = createResponsesWebSocketSessionStore({
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
  });

  store.deferProviderRequests('wss://api.example.test/v1/responses', 60_000);
  const pending = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
    controller.signal,
    (observation) => observations.push(observation.state),
  );
  await Promise.resolve();

  assert.deepEqual(observations, ['rate_limit_waiting']);
  assert.equal(store.readPressureSnapshot().cooldownWaiterCount, 1);

  controller.abort(new Error('user cancelled run'));
  await assert.rejects(pending, /user cancelled run/u);
  assert.equal(connectCalls, 0);
  assert.equal(store.readPressureSnapshot().cooldownWaiterCount, 0);
  assert.deepEqual(observations, ['rate_limit_waiting']);

  await store.closeAll();
});

void test('responses websocket session owner aborts a pending cold connection on shutdown', async () => {
  let rejectConnection: ((error: Error) => void) | undefined;
  let resolveConnecting: (() => void) | undefined;
  let observedShutdownAbort = false;
  const connecting = new Promise<void>((resolve) => {
    resolveConnecting = resolve;
  });
  const store = createResponsesWebSocketSessionStore({
    connectWebSocket(_url, _headers, signal) {
      return new Promise<ResponsesWebSocketSessionSocket>(
        (_resolve, reject) => {
          rejectConnection = reject;
          const rejectForAbort = () => {
            observedShutdownAbort = true;
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error('connection aborted'),
            );
          };
          if (signal?.aborted) {
            rejectForAbort();
          } else {
            signal?.addEventListener('abort', rejectForAbort, { once: true });
          }
          resolveConnecting?.();
        },
      );
    },
  });

  const pending = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'provider-session-a',
    TEST_REUSE_POLICY,
  );
  await connecting;
  assert.equal(store.readPressureSnapshot().connectingSocketCount, 1);

  await store.closeAll();
  if (!observedShutdownAbort) {
    rejectConnection?.(new Error('manual test release'));
  }
  await assert.rejects(pending);
  assert.equal(observedShutdownAbort, true);
  assert.equal(store.readPressureSnapshot().connectingSocketCount, 0);
});

void test('responses websocket session owner shares provider Retry-After admission across sibling sessions', async () => {
  let nowMs = 1_000;
  let connectCalls = 0;
  const observations: string[] = [];
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const store = createResponsesWebSocketSessionStore({
    now: () => nowMs,
    scheduleTimeout(callback, delayMs) {
      const handle = setTimeout(() => {}, 60_000);
      handle.unref();
      scheduled.push({ callback, delayMs, handle });
      return handle;
    },
    clearScheduledTimeout: clearTimeout,
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
  });

  store.deferProviderRequests('wss://api.example.test/v1/responses', 5_000);
  const delayed = store.acquireWebSocket(
    'wss://api.example.test/v2/responses',
    new Headers(),
    'sibling-thread',
    TEST_REUSE_POLICY,
    undefined,
    (observation) => observations.push(observation.state),
  );
  await Promise.resolve();
  assert.equal(connectCalls, 0);
  assert.deepEqual(observations, ['rate_limit_waiting']);
  assert.equal(scheduled[0]?.delayMs, 5_000);
  assert.equal(
    store.readPressureSnapshot().scopes[0]?.cooldownRemainingMs,
    5_000,
  );

  const unrelated = await store.acquireWebSocket(
    'wss://api.other.test/v1/responses',
    new Headers(),
    'other-thread',
    TEST_REUSE_POLICY,
  );
  assert.equal(connectCalls, 1);

  nowMs = 6_000;
  scheduled[0]?.callback();
  const admitted = await delayed;
  assert.equal(connectCalls, 2);
  assert.deepEqual(observations, ['rate_limit_waiting', 'admitted']);
  assert.equal(
    store
      .readPressureSnapshot()
      .scopes.find((scope) => scope.providerScope === 'wss://api.example.test')
      ?.cooldownRemainingMs,
    0,
  );

  admitted.release();
  unrelated.release();
  await store.closeAll();
  for (const item of scheduled) {
    clearTimeout(item.handle);
  }
});

void test('responses websocket session owner admits one half-open probe after a shared provider cooldown', async () => {
  let nowMs = 1_000;
  let connectCalls = 0;
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    handle: ReturnType<typeof setTimeout>;
    active: boolean;
  }> = [];
  const store = createResponsesWebSocketSessionStore({
    now: () => nowMs,
    scheduleTimeout(callback, delayMs) {
      const handle = setTimeout(() => {}, 60_000);
      handle.unref();
      const item = {
        callback: () => {
          item.active = false;
          callback();
        },
        delayMs,
        handle,
        active: true,
      };
      scheduled.push(item);
      return handle;
    },
    clearScheduledTimeout(handle) {
      const item = scheduled.find((candidate) => candidate.handle === handle);
      if (item) {
        item.active = false;
      }
      clearTimeout(handle);
    },
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
  });

  store.deferProviderRequests('wss://api.example.test/v1/responses', 5_000);
  const acquisitions = ['sibling-a', 'sibling-b', 'sibling-c'].map(
    (providerSessionId) =>
      store.acquireWebSocket(
        'wss://api.example.test/v1/responses',
        new Headers(),
        providerSessionId,
        TEST_REUSE_POLICY,
      ),
  );
  await Promise.resolve();

  assert.equal(
    scheduled.filter((item) => item.active).length,
    1,
    'one provider cooldown must own one timer regardless of waiter count',
  );
  assert.equal(connectCalls, 0);
  assert.deepEqual(
    {
      cooldownWaiterCount: store.readPressureSnapshot().cooldownWaiterCount,
      cooldownProbeCount: store.readPressureSnapshot().cooldownProbeCount,
    },
    { cooldownWaiterCount: 3, cooldownProbeCount: 0 },
  );

  nowMs = 6_000;
  scheduled.find((item) => item.active)?.callback();
  const firstProbe = await acquisitions[0];
  assert.ok(firstProbe);
  assert.equal(
    connectCalls,
    1,
    'cooldown expiry must admit one half-open probe',
  );
  assert.deepEqual(
    {
      cooldownWaiterCount: store.readPressureSnapshot().cooldownWaiterCount,
      cooldownProbeCount: store.readPressureSnapshot().cooldownProbeCount,
    },
    { cooldownWaiterCount: 2, cooldownProbeCount: 1 },
  );

  store.deferProviderRequests('wss://api.example.test/v1/responses', 3_000);
  firstProbe.release();
  assert.equal(
    connectCalls,
    1,
    'a probe that observes another Retry-After must keep siblings queued',
  );

  nowMs = 9_000;
  scheduled.find((item) => item.active)?.callback();
  const successfulProbe = await acquisitions[1];
  assert.ok(successfulProbe);
  assert.equal(connectCalls, 2);

  successfulProbe.release();
  const remaining = await acquisitions[2];
  assert.ok(remaining);
  assert.equal(
    connectCalls,
    3,
    'a successful probe must release the remaining provider waiters',
  );

  remaining.release();
  await store.closeAll();
  for (const item of scheduled) {
    clearTimeout(item.handle);
  }
});

void test('responses websocket session owner re-arms cooldown when the half-open connection receives Retry-After', async () => {
  let nowMs = 1_000;
  let connectCalls = 0;
  const scheduled: Array<{
    callback: () => void;
    handle: ReturnType<typeof setTimeout>;
    active: boolean;
  }> = [];
  const store = createResponsesWebSocketSessionStore({
    now: () => nowMs,
    scheduleTimeout(callback) {
      const handle = setTimeout(() => {}, 60_000);
      handle.unref();
      const item = {
        callback: () => {
          item.active = false;
          callback();
        },
        handle,
        active: true,
      };
      scheduled.push(item);
      return handle;
    },
    clearScheduledTimeout(handle) {
      const item = scheduled.find((candidate) => candidate.handle === handle);
      if (item) {
        item.active = false;
      }
      clearTimeout(handle);
    },
    async connectWebSocket() {
      connectCalls += 1;
      if (connectCalls === 1) {
        throw Object.assign(new Error('WebSocket upgrade rejected'), {
          retryAfterMs: 3_000,
        });
      }
      return createFakeSocket();
    },
  });

  store.deferProviderRequests('wss://api.example.test/v1/responses', 5_000);
  const failedProbe = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'sibling-a',
    TEST_REUSE_POLICY,
  );
  const queuedSibling = store.acquireWebSocket(
    'wss://api.example.test/v1/responses',
    new Headers(),
    'sibling-b',
    TEST_REUSE_POLICY,
  );
  await Promise.resolve();

  nowMs = 6_000;
  scheduled.find((item) => item.active)?.callback();
  await assert.rejects(failedProbe, /WebSocket upgrade rejected/u);
  assert.deepEqual(
    {
      connectCalls,
      cooldownWaiterCount: store.readPressureSnapshot().cooldownWaiterCount,
      cooldownProbeCount: store.readPressureSnapshot().cooldownProbeCount,
      cooldownRemainingMs:
        store.readPressureSnapshot().scopes[0]?.cooldownRemainingMs,
    },
    {
      connectCalls: 1,
      cooldownWaiterCount: 1,
      cooldownProbeCount: 0,
      cooldownRemainingMs: 3_000,
    },
  );

  nowMs = 9_000;
  scheduled.find((item) => item.active)?.callback();
  const recovered = await queuedSibling;
  assert.equal(connectCalls, 2);

  recovered.release();
  await store.closeAll();
  for (const item of scheduled) {
    clearTimeout(item.handle);
  }
});

void test('responses websocket session owner applies provider admission accounting to durable requests', async () => {
  let durableCalls = 0;
  const deps = {
    async connectWebSocket() {
      throw new Error('direct socket path must not run');
    },
    durableRequestTransport: {
      async *streamEvents(): AsyncIterable<Record<string, unknown>> {
        durableCalls += 1;
        throw Object.assign(new Error('provider rate limited'), {
          status: 429,
          retryAfterMs: 2_500,
        });
      },
    },
  };
  const store = createResponsesWebSocketSessionStore(deps);
  const streamDurableResponseEvents = Reflect.get(
    store,
    'streamDurableResponseEvents',
  );

  assert.equal(typeof streamDurableResponseEvents, 'function');
  if (typeof streamDurableResponseEvents !== 'function') {
    return;
  }
  const events = Reflect.apply(streamDurableResponseEvents, store, [
    {
      webSocketUrl: 'wss://api.example.test/v1/responses',
      headers: new Headers({ Authorization: 'Bearer private-token' }),
      serializedPayload: '{"type":"response.create"}',
      providerSessionId: 'provider-session-a',
      requestAttempt: 0,
    },
  ]) as AsyncIterable<Record<string, unknown>>;

  await assert.rejects(async () => {
    for await (const event of events) {
      void event;
    }
  }, /provider rate limited/u);
  assert.equal(durableCalls, 1);
  assert.ok(
    store
      .readPressureSnapshot()
      .scopes.some(
        (scope) =>
          scope.providerScope === 'wss://api.example.test' &&
          scope.cooldownRemainingMs > 0,
      ),
  );
  await store.closeAll();
});

void test('responses session owner applies shared provider admission to durable HTTP SSE requests', async () => {
  let durableHttpCalls = 0;
  let observedSignal: AbortSignal | undefined;
  const store = createResponsesWebSocketSessionStore({
    async connectWebSocket() {
      throw new Error('direct socket path must not run');
    },
    durableRequestTransport: {
      async *streamEvents(): AsyncIterable<Record<string, unknown>> {
        throw new Error('responses websocket durable path must not run');
      },
      async *streamHttpSseEvents(
        input,
      ): AsyncIterable<Record<string, unknown>> {
        durableHttpCalls += 1;
        observedSignal = input.signal;
        throw Object.assign(new Error('HTTP provider rate limited'), {
          status: 429,
          retryAfterMs: 2_500,
        });
      },
    },
  });
  const streamDurableHttpSseEvents = store.streamDurableHttpSseEvents;
  assert.notEqual(streamDurableHttpSseEvents, undefined);

  await assert.rejects(async () => {
    for await (const event of streamDurableHttpSseEvents?.({
      requestUrl: 'https://api.example.test/v1/chat/completions',
      headers: new Headers({ Authorization: 'Bearer private-token' }),
      serializedPayload: '{"model":"test-model","stream":true}',
      providerSessionId: 'provider-session-http',
      requestAttempt: 0,
      resolveProviderAdmissionFallbackDelayMs() {
        assert.fail(
          'factual Retry-After must win without consulting fallback policy',
        );
      },
    }) ?? []) {
      void event;
    }
  }, /HTTP provider rate limited/u);
  assert.equal(durableHttpCalls, 1);
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.ok(
    store
      .readPressureSnapshot()
      .scopes.some(
        (scope) =>
          scope.providerScope === 'https://api.example.test' &&
          scope.cooldownRemainingMs > 0,
      ),
  );
  await store.closeAll();
});

void test('durable HTTP admission uses the caller retry policy when Retry-After is absent', async () => {
  const nowMs = 10_000;
  const resolverErrors: unknown[] = [];
  const store = createResponsesWebSocketSessionStore({
    now: () => nowMs,
    async connectWebSocket() {
      throw new Error('direct socket path must not run');
    },
    durableRequestTransport: {
      async *streamEvents(): AsyncIterable<Record<string, unknown>> {
        throw new Error('responses websocket durable path must not run');
      },
      async *streamHttpSseEvents(): AsyncIterable<Record<string, unknown>> {
        throw Object.assign(
          new Error('HTTP provider rate limited without Retry-After'),
          { status: 429 },
        );
      },
    },
  });
  const streamDurableHttpSseEvents = store.streamDurableHttpSseEvents;
  assert.notEqual(streamDurableHttpSseEvents, undefined);

  await assert.rejects(async () => {
    for await (const event of streamDurableHttpSseEvents?.({
      requestUrl: 'https://api.example.test/v1/chat/completions',
      headers: new Headers({ Authorization: 'Bearer private-token' }),
      serializedPayload: '{"model":"test-model","stream":true}',
      providerSessionId: 'provider-session-http-fallback',
      requestAttempt: 0,
      resolveProviderAdmissionFallbackDelayMs(error) {
        resolverErrors.push(error);
        return 1_750;
      },
    }) ?? []) {
      void event;
    }
  }, /without Retry-After/u);

  assert.equal(resolverErrors.length, 1);
  assert.equal(
    store
      .readPressureSnapshot()
      .scopes.find(
        (scope) => scope.providerScope === 'https://api.example.test',
      )?.cooldownRemainingMs,
    1_750,
  );
  await store.closeAll();
});
