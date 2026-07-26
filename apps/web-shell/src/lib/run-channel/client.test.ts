import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  RunChannelClientMessage,
  RunChannelServerMessage,
} from '@geulbat/protocol/run-channel';

import { brandRunId, brandThreadId } from '../id-brand-helpers.js';
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
    this.emitRawMessage(JSON.stringify(message));
  }

  emitRawMessage(data: string): void {
    this.dispatch('message', { data });
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
  if (authMessage.type === 'run.auth') {
    assert.equal(authMessage.computerSessionId, 'computer-session-harness');
  }
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
    buildAuthMessage: (requestId, computerSessionId) => ({
      type: 'run.auth',
      requestId,
      computerSessionId,
      token: 'test-token',
    }),
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduleTask: scheduler.schedule,
    clearScheduledTask: scheduler.clear,
    computerSessionId: 'computer-session-harness',
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
  assert.deepEqual(harness.messages, []);

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
    promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
  });
  const startMessage = JSON.parse(
    reconnectSocket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(startMessage.type, 'run.start');
});

void test('RunChannelClient restores active-run identity before auth completes and reconnects from its last cursor', async () => {
  const harness = createClientHarness();
  const runId = brandRunId('run-reconnect-cursor');
  const threadId = brandThreadId('123e4567-e89b-42d3-a456-426614174020');
  const connectPromise = harness.client.connect();
  const socket = getSocket(harness.sockets);
  socket.emitOpen();
  socket.emitMessage({
    type: 'run.event',
    event: {
      runId,
      threadId,
      seq: 4,
      ts: new Date().toISOString(),
      type: 'run_ack',
      payload: { runId, threadId },
    },
  });

  assert.deepEqual(harness.client.getActiveRunForThread(threadId), {
    runId,
    threadId,
  });
  socket.emitMessage({
    type: 'run.auth.ok',
    requestId: parseAuthRequestId(socket),
    ok: true,
  });
  await connectPromise;

  socket.close();
  harness.scheduler.runNext();
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  const reconnectAuth = JSON.parse(
    reconnectSocket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(reconnectAuth.type, 'run.auth');
  if (reconnectAuth.type !== 'run.auth') {
    return;
  }
  assert.deepEqual(reconnectAuth.runEventCursors, [{ runId, seq: 4 }]);
  assert.deepEqual(reconnectAuth.threadSubscriptions, [threadId]);
});

void test('RunChannelClient clears active identity but retains the terminal cursor across reconnect', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const runId = brandRunId('run-terminal-active-identity');
  const threadId = brandThreadId('123e4567-e89b-42d3-a456-426614174021');
  socket.emitMessage({
    type: 'run.event',
    event: {
      runId,
      threadId,
      seq: 0,
      ts: new Date().toISOString(),
      type: 'run_ack',
      payload: { runId, threadId },
    },
  });
  socket.emitMessage({
    type: 'run.event',
    event: {
      runId,
      threadId,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'done',
      payload: { ok: true, answer: 'done' },
    },
  });

  assert.equal(harness.client.getActiveRunForThread(threadId), null);
  socket.close();
  harness.scheduler.runNext();
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  const reconnectAuth = JSON.parse(
    reconnectSocket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(reconnectAuth.type, 'run.auth');
  if (reconnectAuth.type !== 'run.auth') {
    return;
  }
  assert.deepEqual(reconnectAuth.runEventCursors, [{ runId, seq: 1 }]);
  assert.deepEqual(reconnectAuth.threadSubscriptions, [threadId]);
});

void test('RunChannelClient subscribes the selected thread without reconnecting and retains it for later auth', async () => {
  const harness = createClientHarness();
  const firstThreadId = brandThreadId('123e4567-e89b-42d3-a456-426614174022');
  const secondThreadId = brandThreadId('123e4567-e89b-42d3-a456-426614174023');

  await harness.client.subscribeThread(firstThreadId);
  const socket = await connectAuthenticatedClient(harness);
  const initialAuth = JSON.parse(
    socket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(initialAuth.type, 'run.auth');
  if (initialAuth.type === 'run.auth') {
    assert.deepEqual(initialAuth.threadSubscriptions, [firstThreadId]);
  }

  await harness.client.subscribeThread(secondThreadId);
  assert.deepEqual(JSON.parse(socket.sent[1] ?? 'null'), {
    type: 'run.thread.subscribe',
    requestId: JSON.parse(socket.sent[1] ?? 'null').requestId,
    request: { threadId: secondThreadId },
  });

  await harness.client.subscribeThread(secondThreadId);
  assert.equal(socket.sent.length, 2);

  socket.close();
  harness.scheduler.runNext();
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  const reconnectAuth = JSON.parse(
    reconnectSocket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(reconnectAuth.type, 'run.auth');
  if (reconnectAuth.type === 'run.auth') {
    assert.deepEqual(reconnectAuth.threadSubscriptions, [
      firstThreadId,
      secondThreadId,
    ]);
  }
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

void test('RunChannelClient sends an exact run event acknowledgement cursor', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const runId = brandRunId('run-event-ack');
  const threadId = brandThreadId('123e4567-e89b-42d3-a456-426614174000');
  socket.emitMessage({
    type: 'run.event',
    event: {
      runId,
      threadId,
      seq: 7,
      ts: new Date().toISOString(),
      type: 'done',
      payload: { ok: true, answer: 'acknowledged terminal' },
    },
  });

  const acknowledgementPromise = harness.client.acknowledgeEvent({
    runId,
    threadId,
    seq: 7,
  });
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.event.ack');
  if (message.type !== 'run.event.ack') {
    return;
  }
  assert.deepEqual(message.request, { runId, threadId, seq: 7 });

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'run.event.ack',
    ok: true,
    seq: 7,
  });
  assert.equal(await acknowledgementPromise, message.requestId);

  socket.close();
  harness.scheduler.runNext();
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  const reconnectAuth = JSON.parse(
    reconnectSocket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(reconnectAuth.type, 'run.auth');
  if (reconnectAuth.type === 'run.auth') {
    assert.equal('runEventCursors' in reconnectAuth, false);
  }
});

void test('RunChannelClient keeps run event acknowledgement conflicts out of the session stream', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const acknowledgementPromise = harness.client.acknowledgeEvent({
    runId: brandRunId('run-event-ack-conflict'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    seq: 7,
  });
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.event.ack');
  if (message.type !== 'run.event.ack') {
    return;
  }

  socket.emitMessage({
    type: 'run.error',
    requestId: message.requestId,
    code: 'conflict',
    message: 'run event acknowledgement rejected: cursor_conflict',
    status: 409,
  });

  await assert.rejects(acknowledgementPromise, /cursor_conflict/u);
  assert.deepEqual(harness.messages, []);
});

void test('RunChannelClient waits for the correlated run.approve acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const approvalPromise = harness.client.approve({
    callId: 'call-approve-ack',
    runId: brandRunId('run-approve-ack'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    approved: true,
    grantScope: 'once',
  });
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.approve');
  if (message.type !== 'run.approve') {
    return;
  }

  let settled = false;
  void approvalPromise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(settled, false);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'run.approve',
    ok: true,
  });

  assert.equal(await approvalPromise, message.requestId);
});

void test('RunChannelClient correlates a trusted planning command acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    kind: 'approve' as const,
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    workflowId: 'workflow-trusted',
    planId: 'plan-trusted',
    revision: 2,
    digest:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
  };

  const commandPromise = harness.client.planCommand(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'plan.command');
  if (message.type !== 'plan.command') {
    return;
  }
  assert.deepEqual(message.request, request);

  let settled = false;
  void commandPromise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(settled, false);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'plan.command',
    ok: true,
    commandKind: 'approve',
    snapshot: null,
    approvedPlanRef: {
      workflowId: request.workflowId,
      planId: request.planId,
      revision: request.revision,
      digest: request.digest,
    },
  });

  assert.deepEqual(await commandPromise, {
    type: 'run.control',
    requestId: message.requestId,
    action: 'plan.command',
    ok: true,
    commandKind: 'approve',
    snapshot: null,
    approvedPlanRef: {
      workflowId: request.workflowId,
      planId: request.planId,
      revision: request.revision,
      digest: request.digest,
    },
  });
});

void test('RunChannelClient correlates a Goal command acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    kind: 'resume' as const,
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174084'),
    goalId: 'goal-trusted',
  };

  const commandPromise = harness.client.goalCommand(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'goal.command');
  if (message.type !== 'goal.command') {
    return;
  }
  assert.deepEqual(message.request, request);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'goal.command',
    ok: true,
    commandKind: 'resume',
    snapshot: null,
  });

  const control = await commandPromise;
  assert.equal(control.action, 'goal.command');
  assert.equal(control.commandKind, 'resume');
  assert.equal(control.snapshot, null);
});

void test('RunChannelClient waits for the correlated child cancel acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const request = {
    parentRunId: brandRunId('run-child-cancel-parent'),
    childRunId: brandRunId('run-child-cancel-target'),
  };

  const cancelPromise = harness.client.cancelChild(request);
  await Promise.resolve();

  const message = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'run.child.cancel');
  if (message.type !== 'run.child.cancel') {
    return;
  }
  assert.deepEqual(message.request, request);

  socket.emitMessage({
    type: 'run.control',
    requestId: message.requestId,
    action: 'run.child.cancel',
    ok: true,
  });

  assert.equal(await cancelPromise, message.requestId);
});

void test('RunChannelClient rejects an unacknowledged approval when the socket disconnects', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const approvalPromise = harness.client.approve({
    callId: 'call-approve-disconnect',
    runId: brandRunId('run-approve-disconnect'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    approved: true,
    grantScope: 'once',
  });
  await Promise.resolve();

  socket.close();

  await assert.rejects(approvalPromise, /run channel disconnected/u);
  assert.equal(harness.scheduler.size, 1);
});

void test('RunChannelClient closes an approval auth handshake without a dangling acknowledgement', async () => {
  const harness = createClientHarness();
  const approvalPromise = harness.client.approve({
    callId: 'call-approve-auth-close',
    runId: brandRunId('run-approve-auth-close'),
    threadId: brandThreadId('123e4567-e89b-42d3-a456-426614174000'),
    approved: true,
    grantScope: 'once',
  });
  const socket = getSocket(harness.sockets);

  harness.client.close();

  await assert.rejects(approvalPromise, /run channel closed/u);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(socket.readyState, 3);
  assert.equal(harness.scheduler.size, 0);
});

void test('RunChannelClient waits for run.interject acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  let settled = false;
  void interjectPromise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  socket.emitMessage({
    type: 'run.control',
    requestId: interjectMessage.requestId,
    action: 'run.interject',
    ok: true,
    receivedSeq: 1,
    bufferDepth: 0,
  });

  assert.deepEqual(await interjectPromise, {
    requestId: interjectMessage.requestId,
    receivedSeq: 1,
  });
});

void test('RunChannelClient rejects run.interject on matching run.error', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  socket.emitMessage({
    type: 'run.error',
    requestId: interjectMessage.requestId,
    code: 'bad_request',
    message: 'mid-run steer is not enabled',
    status: 503,
  });

  await assert.rejects(interjectPromise, /mid-run steer is not enabled/);
});

void test('RunChannelClient waits for run.interject.flush acknowledgement', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  const flushPromise = harness.client.flushInterject({
    runId: brandRunId('run-1'),
  });
  await Promise.resolve();
  const flushMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(flushMessage.type, 'run.interject.flush');
  if (flushMessage.type !== 'run.interject.flush') {
    return;
  }
  assert.deepEqual(flushMessage.request, { runId: 'run-1' });

  socket.emitMessage({
    type: 'run.control',
    requestId: flushMessage.requestId,
    action: 'run.interject.flush',
    ok: true,
    flushed: true,
  });

  assert.deepEqual(await flushPromise, { flushed: true });
});

void test('RunChannelClient keeps control-scoped run.error out of the session stream', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const received: RunChannelServerMessage[] = [];
  harness.client.subscribe((message) => {
    received.push(message);
  });

  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  socket.emitMessage({
    type: 'run.error',
    requestId: interjectMessage.requestId,
    code: 'bad_request',
    message: 'mid-run steer is not enabled',
    status: 503,
  });
  await assert.rejects(interjectPromise, /mid-run steer is not enabled/);
  // The awaiting caller owns this failure; the session stream must not see
  // it (it would flip the run view into the error phase mid-run).
  assert.equal(received.length, 0);

  socket.emitMessage({
    type: 'run.error',
    code: 'internal',
    message: 'transport broke',
    status: 500,
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, 'run.error');
});

void test('RunChannelClient rejects malformed control responses without failing the active session', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const interjectPromise = harness.client.interject({
    runId: brandRunId('run-1'),
    text: 'steer',
  });
  await Promise.resolve();
  const interjectMessage = JSON.parse(
    socket.sent[1] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(interjectMessage.type, 'run.interject');
  if (interjectMessage.type !== 'run.interject') {
    return;
  }

  socket.emitRawMessage(
    JSON.stringify({
      type: 'run.control',
      requestId: interjectMessage.requestId,
      action: 'run.interject',
      ok: true,
      receivedSeq: 'invalid',
      bufferDepth: 0,
    }),
  );

  await assert.rejects(interjectPromise, /invalid websocket payload/);
  assert.equal(socket.readyState, 1);
  assert.equal(harness.messages.length, 0);
  assert.equal(harness.scheduler.size, 0);
});

void test('RunChannelClient closes the socket on unmatched malformed server payloads', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  socket.emitRawMessage(
    JSON.stringify({
      type: 'run.event',
      event: null,
    }),
  );

  assert.equal(socket.readyState, 3);
  assert.equal(harness.messages.length, 1);
  assert.deepEqual(harness.messages[0], {
    type: 'run.error',
    code: 'internal',
    message: 'invalid websocket payload',
    status: 500,
  });
  assert.equal(harness.scheduler.size, 1);
});

void test('RunChannelClient explicit close rejects and closes an in-flight connection', async () => {
  const harness = createClientHarness();
  const connectPromise = harness.client.connect();
  const socket = getSocket(harness.sockets);

  harness.client.close();
  const readyStateAfterClose = socket.readyState;
  socket.emitError();

  await assert.rejects(connectPromise, /run channel closed/u);
  assert.equal(readyStateAfterClose, 3);
  assert.equal(harness.scheduler.size, 0);
});

void test('RunChannelClient ends its computer session before closing the transport', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  harness.client.endComputerSession();

  const message = JSON.parse(
    socket.sent.at(-1) ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(message.type, 'computer.session.end');
  if (message.type !== 'computer.session.end') {
    return;
  }
  assert.equal(message.requestId.trim().length > 0, true);
  assert.deepEqual(Object.keys(message).sort(), ['requestId', 'type']);
  assert.equal(socket.readyState, 3);
  assert.equal(harness.scheduler.size, 0);

  const sentAfterEnd = socket.sent.length;
  harness.client.endComputerSession();
  assert.equal(socket.sent.length, sentAfterEnd);
  await assert.rejects(harness.client.connect(), /computer session ended/u);
});

void test('RunChannelClient transport close preserves its computer session', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);
  const sentBeforeClose = socket.sent.length;

  harness.client.close();

  assert.equal(socket.sent.length, sentBeforeClose);
  assert.equal(socket.readyState, 3);
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

void test('RunChannelClient continues reconnecting beyond the former retry ceiling', async () => {
  const harness = createClientHarness();
  await connectAuthenticatedClient(harness);

  getSocket(harness.sockets).close();
  assert.equal(harness.scheduler.peekDelay(), 500);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    harness.scheduler.runNext();
    getSocket(harness.sockets, attempt + 1).emitError();
    await Promise.resolve();
    assert.equal(harness.scheduler.size, 1);
  }

  assert.deepEqual(harness.messages, []);
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
