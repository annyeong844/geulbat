import test from 'node:test';
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import {
  createResponsesWebSocketSessionStore,
  type ResponsesWebSocketSessionSocket,
} from './responses-websocket-cache.js';

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
    ttlMs: 50,
    async connectWebSocket() {
      connectCalls += 1;
      return createFakeSocket();
    },
  });

  const first = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
  );
  first.release({ keep: true });

  const second = await store.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
  );

  assert.equal(second.socket, first.socket);
  assert.equal(connectCalls, 1);

  second.release({ keep: false });
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
  );
  const secondHandle = await second.acquireWebSocket(
    'ws://example.test',
    new Headers(),
    'provider-session-a',
  );

  assert.notEqual(firstHandle.socket, secondHandle.socket);
  assert.equal(connectCalls, 2);

  firstHandle.release({ keep: false });
  secondHandle.release({ keep: false });
});
