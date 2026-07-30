import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';

import { brandRunId, brandThreadId } from '../id-brand-helpers.js';
import {
  connectAuthenticatedClient,
  createClientHarness,
  getSocket,
  parseAuthRequestId,
  TEST_COMPUTER_SESSION_ID,
} from '../../test-support/run-channel-client-harness.js';
import { buildRunChannelUrl, getReconnectDelay } from './client.js';

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
    computerSessionId: TEST_COMPUTER_SESSION_ID,
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
    computerSessionId: TEST_COMPUTER_SESSION_ID,
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

void test('RunChannelClient does not replace a durable cursor with socket-local child activity', async () => {
  const harness = createClientHarness();
  const runId = brandRunId('run-reconnect-child-status');
  const childRunId = brandRunId('run-reconnect-child');
  const threadId = brandThreadId('123e4567-e89b-42d3-a456-426614174024');
  const childThreadId = brandThreadId('123e4567-e89b-42d3-a456-426614174025');
  const socket = await connectAuthenticatedClient(harness);
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
  socket.emitMessage({
    type: 'run.event',
    runEventCursor: false,
    event: {
      runId,
      threadId,
      seq: 0,
      ts: new Date().toISOString(),
      type: 'subagent_status',
      payload: {
        parentRunId: runId,
        childRunId,
        childThreadId,
        subagentType: 'explorer',
        capabilities: [],
        toolSurface: 'explorer',
        runtime: {
          phase: 'provider_waiting',
          observedAt: new Date().toISOString(),
          partialOutputAvailable: false,
        },
      },
    },
  });

  socket.close();
  harness.scheduler.runNext();
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  const reconnectAuth = JSON.parse(
    reconnectSocket.sent[0] ?? 'null',
  ) as RunChannelClientMessage;
  assert.equal(reconnectAuth.type, 'run.auth');
  if (reconnectAuth.type === 'run.auth') {
    assert.deepEqual(reconnectAuth.runEventCursors, [{ runId, seq: 4 }]);
  }
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
    computerSessionId: TEST_COMPUTER_SESSION_ID,
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

void test('RunChannelClient refuses a different host-issued session after reconnect', async () => {
  const harness = createClientHarness();
  const socket = await connectAuthenticatedClient(harness);

  socket.close();
  harness.scheduler.runNext();
  const reconnectSocket = getSocket(harness.sockets, 1);
  reconnectSocket.emitOpen();
  reconnectSocket.emitMessage({
    type: 'run.auth.ok',
    requestId: parseAuthRequestId(reconnectSocket),
    ok: true,
    computerSessionId: 'different-computer-session',
  });
  await Promise.resolve();

  assert.equal(reconnectSocket.readyState, 3);
  assert.equal(harness.scheduler.size, 0);
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
