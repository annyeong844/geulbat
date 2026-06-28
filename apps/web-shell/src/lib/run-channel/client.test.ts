import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  RunChannelClientMessage,
  RunChannelServerMessage,
} from '@geulbat/protocol/run-channel';

import { brandProjectId } from '../id-brand-helpers.js';
import {
  buildRunChannelUrl,
  getReconnectDelay,
  RunChannelClient,
} from './client.js';

class ManualScheduler {
  private nextId = 1;
  private tasks = new Map<number, { callback: () => void; delayMs: number }>();

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delayMs });
    return id;
  };

  clear = (handle: unknown): void => {
    if (typeof handle !== 'number') {
      return;
    }
    this.tasks.delete(handle);
  };

  get size(): number {
    return this.tasks.size;
  }

  peekDelay(): number | null {
    const first = this.tasks.values().next().value as
      | { delayMs: number }
      | undefined;
    return first?.delayMs ?? null;
  }

  runNext(): void {
    const first = this.tasks.entries().next().value as
      | [number, { callback: () => void }]
      | undefined;
    assert.ok(first);
    const [id, task] = first;
    this.tasks.delete(id);
    task.callback();
  }
}

type FakeSocketEventMap = {
  open: undefined;
  message: { data: string };
  close: undefined;
  error: undefined;
};

class FakeSocket {
  readyState = 0;
  sent: string[] = [];

  private listeners: Record<
    keyof FakeSocketEventMap,
    Array<{ listener: (event: unknown) => void; once: boolean }>
  > = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  addEventListener<K extends keyof FakeSocketEventMap>(
    type: K,
    listener: (event: FakeSocketEventMap[K]) => void,
    options?: { once?: boolean },
  ): void {
    this.listeners[type].push({
      listener: listener as (event: unknown) => void,
      once: options?.once === true,
    });
  }

  removeEventListener<K extends keyof FakeSocketEventMap>(
    type: K,
    listener: (event: FakeSocketEventMap[K]) => void,
  ): void {
    this.listeners[type] = this.listeners[type].filter(
      (entry) => entry.listener !== (listener as (event: unknown) => void),
    );
  }

  listenerCount(type: keyof FakeSocketEventMap): number {
    return this.listeners[type].length;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch('close', undefined);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatch('open', undefined);
  }

  emitMessage(message: RunChannelServerMessage): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  emitError(): void {
    this.dispatch('error', undefined);
  }

  private dispatch<K extends keyof FakeSocketEventMap>(
    type: K,
    event: FakeSocketEventMap[K],
  ): void {
    const snapshot = [...this.listeners[type]];
    this.listeners[type] = this.listeners[type].filter(
      (entry) => entry.once !== true,
    );
    for (const entry of snapshot) {
      entry.listener(event);
    }
  }
}

function parseAuthRequestId(socket: FakeSocket): string {
  assert.ok(socket.sent.length > 0);
  const authMessage = JSON.parse(
    socket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(authMessage.type, 'run.auth');
  return authMessage.requestId;
}

function createClientHarness(): {
  scheduler: ManualScheduler;
  sockets: FakeSocket[];
  messages: RunChannelServerMessage[];
  client: RunChannelClient;
} {
  const scheduler = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const messages: RunChannelServerMessage[] = [];
  const client = new RunChannelClient({
    getWebSocketUrl: () => 'ws://example.test/api/ws',
    buildAuthMessage: (requestId) => ({
      type: 'run.auth',
      requestId,
      token: 'test-token',
    }),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduleTask: scheduler.schedule,
    clearScheduledTask: scheduler.clear,
  });
  client.subscribe((message) => {
    messages.push(message);
  });
  return { scheduler, sockets, messages, client };
}

function getSocket(sockets: FakeSocket[], index = 0): FakeSocket {
  const socket = sockets[index];
  assert.ok(socket);
  return socket;
}

async function connectAuthenticatedClient(harness: {
  sockets: FakeSocket[];
  client: RunChannelClient;
}): Promise<FakeSocket> {
  const connectPromise = harness.client.connect();
  const socket = getSocket(harness.sockets);
  socket.emitOpen();
  socket.emitMessage({
    type: 'run.auth.ok',
    requestId: parseAuthRequestId(socket),
    ok: true,
  });
  await connectPromise;
  return socket;
}

void test('buildRunChannelUrl uses the expected websocket scheme', () => {
  const cases = [
    ['http://127.0.0.1:5174', 'ws://127.0.0.1:5174/api/ws'],
    ['https://example.com', 'wss://example.com/api/ws'],
  ] as const;

  for (const [origin, expected] of cases) {
    assert.equal(buildRunChannelUrl(origin), expected);
  }
});

void test('getReconnectDelay backs off and caps', () => {
  const cases = [
    [0, 500],
    [1, 1_000],
    [2, 2_000],
    [3, 5_000],
    [99, 5_000],
  ] as const;

  for (const [attempt, expected] of cases) {
    assert.equal(getReconnectDelay(attempt), expected);
  }
});

void test('RunChannelClient reconnects after unexpected authenticated close', async () => {
  const harness = createClientHarness();
  await connectAuthenticatedClient(harness);

  getSocket(harness.sockets).close();
  assert.equal(harness.scheduler.peekDelay(), 500);
  assert.deepEqual(harness.messages.at(-1), {
    type: 'run.error',
    code: 'internal',
    message: 'run channel disconnected',
    status: 500,
  });

  harness.scheduler.runNext();
  assert.equal(harness.sockets.length, 2);
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  reconnectSocket.emitMessage({
    type: 'run.auth.ok',
    requestId: parseAuthRequestId(reconnectSocket),
    ok: true,
  });
  await Promise.resolve();

  await harness.client.start({
    projectId: brandProjectId('workspace'),
    promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
  });
  const startMessage = JSON.parse(
    reconnectSocket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(startMessage.type, 'run.start');
});

void test('RunChannelClient detaches stale socket listeners after reconnect', async () => {
  const harness = createClientHarness();
  const staleSocket = await connectAuthenticatedClient(harness);

  staleSocket.close();
  harness.scheduler.runNext();
  const liveSocket = getSocket(harness.sockets, 1);
  liveSocket.emitOpen();
  liveSocket.emitMessage({
    type: 'run.auth.ok',
    requestId: parseAuthRequestId(liveSocket),
    ok: true,
  });
  await Promise.resolve();

  assert.equal(staleSocket.listenerCount('message'), 0);
  assert.equal(staleSocket.listenerCount('close'), 0);
  const messageCount = harness.messages.length;
  staleSocket.emitMessage({
    type: 'run.error',
    code: 'internal',
    message: 'stale socket error',
    status: 500,
  });
  assert.equal(harness.messages.length, messageCount);
});

void test('RunChannelClient sends supplied prompt refs without inline prompts', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  await harness.client.start({
    projectId: brandProjectId('workspace'),
    promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
  });

  const startMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(startMessage.type, 'run.start');
  if (startMessage.type !== 'run.start') {
    return;
  }
  assert.equal('promptRef' in startMessage.request, true);
  if (!('promptRef' in startMessage.request)) {
    return;
  }
  assert.equal(
    startMessage.request.promptRef,
    'run-prompt-input:11111111-1111-4111-8111-111111111111',
  );
  assert.equal('prompt' in startMessage.request, false);
});

void test('RunChannelClient close clears pending reconnect task', async () => {
  const harness = createClientHarness();
  await connectAuthenticatedClient(harness);

  getSocket(harness.sockets).close();
  assert.equal(harness.scheduler.size, 1);
  harness.client.close();
  assert.equal(harness.scheduler.size, 0);
});

void test('RunChannelClient transport connect failure schedules reconnect', async () => {
  const harness = createClientHarness();
  const connectPromise = harness.client.connect();
  getSocket(harness.sockets).emitError();

  await assert.rejects(
    connectPromise,
    /run channel websocket connection failed/,
  );
  assert.equal(harness.scheduler.peekDelay(), 500);
});

void test('RunChannelClient surfaces a terminal reconnect failure after the retry ceiling', async () => {
  const harness = createClientHarness();
  await connectAuthenticatedClient(harness);

  getSocket(harness.sockets).close();
  assert.equal(harness.scheduler.peekDelay(), 500);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    harness.scheduler.runNext();
    getSocket(harness.sockets, attempt + 1).emitError();
    await Promise.resolve();
  }

  assert.equal(harness.scheduler.size, 0);
  assert.deepEqual(harness.messages.at(-1), {
    type: 'run.error',
    code: 'internal',
    message: 'run channel reconnect failed',
    status: 500,
  });
});

void test('RunChannelClient auth rejection does not schedule reconnect', async () => {
  const harness = createClientHarness();
  const connectPromise = harness.client.connect();
  const socket = getSocket(harness.sockets);
  socket.emitOpen();
  socket.emitMessage({
    type: 'run.error',
    requestId: parseAuthRequestId(socket),
    code: 'unauthorized',
    message: 'bad token',
    status: 401,
  });

  await assert.rejects(connectPromise, /bad token/);
  assert.equal(harness.scheduler.size, 0);
});
