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
