import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunId, type RunId } from '@geulbat/protocol/ids';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import {
  cleanupSocketState,
  createSocketRunEventSink,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createRunChannelTestDaemonContext as createBaseRunChannelTestDaemonContext,
  createTestSocket,
} from '../../../test-support/run-channel-test-support.js';
import { handleClientMessage } from './run-channel-dispatch.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const TEST_COMPUTER_SESSION_ID = 'computer-session-dispatch-test';
function createRunChannelTestDaemonContext() {
  const daemonContext = createBaseRunChannelTestDaemonContext();
  daemonContext.computerSessionId = TEST_COMPUTER_SESSION_ID;
  return daemonContext;
}

void test('handleClientMessage automatically rebinds detached run delivery after auth', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const detachedSocket = createTestSocket();
  const detachedState = getSocketState(detachedSocket);
  detachedState.computerSessionId = daemonContext.computerSessionId;
  const runId = 'run-auto-rebind-after-auth' as RunId;
  const threadId = testThreadId(61);
  detachedState.activeRunIds.add(runId);
  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: detachedState.computerSessionId,
    sink: () => true,
    async persistRunEvents() {},
  });
  daemonContext.liveRunEvents.publishRunEvent(runId, {
    type: 'commentary_delta',
    payload: { text: 'already rendered before disconnect' },
  });
  cleanupSocketState(detachedSocket, daemonContext);
  daemonContext.liveRunEvents.publishRunEvent(runId, {
    type: 'commentary_delta',
    payload: { text: 'continued while disconnected' },
  });

  const replacementSocket = createTestSocket();
  const replacementState = getSocketState(replacementSocket);
  replacementState.upgradeAuthorized = true;

  try {
    await handleClientMessage(
      replacementSocket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-auto-rebind',
        token: 'proxy-authenticated',
        runEventCursors: [{ runId, seq: 0 }],
      }),
      daemonContext,
    );

    const messages = replacementSocket.sentFrames.map(
      (frame) => JSON.parse(frame) as RunChannelServerMessage,
    );
    assert.equal(messages.length, 2);
    const message = messages[0];
    assert.equal(message?.type, 'run.event');
    if (message?.type !== 'run.event') {
      return;
    }
    assert.equal(message.event.runId, runId);
    assert.equal(message.event.threadId, threadId);
    assert.equal(message.event.seq, 1);
    assert.equal(message.event.type, 'commentary_delta');
    assert.deepEqual(message.event.payload, {
      text: 'continued while disconnected',
    });
    assert.deepEqual(messages[1], {
      type: 'run.auth.ok',
      requestId: 'auth-auto-rebind',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });
    assert.equal(replacementState.activeRunIds.has(runId), true);
    assert.equal(
      replacementState.computerSessionId,
      detachedState.computerSessionId,
    );
  } finally {
    cleanupSocketState(replacementSocket, daemonContext);
  }
});

void test('handleClientMessage replays a pending child terminal result from an explicit auth thread subscription after daemon restart', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(228);
  const parentRunId = assertRunId('123e4567-e89b-42d3-a456-426614174228');
  const childRunId = assertRunId('123e4567-e89b-42d3-a456-426614174229');
  getSocketState(socket).upgradeAuthorized = true;
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    threadId,
    {
      deliveryId: 'delivery-after-daemon-restart',
      parentRunId,
      childRunId,
      subagentType: 'worker',
      terminalState: 'failed',
      reason: 'child_error',
      result: 'daemon restarted while the child was running',
      completedAt: '2026-07-23T08:42:59.000Z',
    },
  );

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-thread-subscription',
        token: 'proxy-authenticated',
        threadSubscriptions: [threadId],
      }),
      daemonContext,
    );

    const messages = socket.sentFrames.map(
      (frame) => JSON.parse(frame) as RunChannelServerMessage,
    );
    assert.equal(messages.length, 4);
    const terminal = messages[0];
    assert.equal(terminal?.type, 'run.event');
    if (terminal?.type === 'run.event') {
      assert.equal(terminal.event.type, 'subagent_terminal');
      assert.equal(terminal.event.threadId, threadId);
      assert.equal(terminal.event.runId, childRunId);
    }
    assert.deepEqual(messages[1], {
      type: 'run.auth.ok',
      requestId: 'auth-thread-subscription',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });
    assert.deepEqual(messages[2], {
      type: 'plan.workflow',
      threadId,
      snapshot: null,
    });
    assert.deepEqual(messages[3], {
      type: 'goal.state',
      threadId,
      snapshot: null,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('authenticated reconnect replays detached live history once before auth completion', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const detachedSocket = createTestSocket();
  const detachedState = getSocketState(detachedSocket);
  detachedState.computerSessionId = daemonContext.computerSessionId;
  const threadId = testThreadId(63);
  const runId = assertRunId('run-live-terminal-before-durable');
  detachedState.activeRunIds.add(runId);

  await daemonContext.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });
  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: detachedState.computerSessionId,
    sink: createSocketRunEventSink(detachedSocket),
    async persistRunEvents(events) {
      await daemonContext.runCheckpoints.appendRunEvents({
        threadId,
        runId,
        events,
      });
    },
  });
  daemonContext.liveRunEvents.publishRunEvent(runId, {
    type: 'run_ack',
    payload: { runId, threadId },
  });
  cleanupSocketState(detachedSocket, daemonContext);
  await daemonContext.liveRunEvents.commitTerminalRunEvent({
    runId,
    event: {
      type: 'done',
      payload: { answer: 'one delivery', ok: true },
    },
    async persist(envelope) {
      await daemonContext.runCheckpoints.settleRun({
        threadId,
        runId,
        terminal: {
          eventCursor: envelope.seq,
          event: envelope.event,
        },
      });
    },
  });
  daemonContext.liveRunEvents.finishRun(runId);

  const replacementSocket = createTestSocket();
  getSocketState(replacementSocket).upgradeAuthorized = true;
  try {
    await handleClientMessage(
      replacementSocket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-live-terminal-before-durable',
        token: 'proxy-authenticated',
      }),
      daemonContext,
    );

    const messages = replacementSocket.sentFrames.map(
      (frame) => JSON.parse(frame) as RunChannelServerMessage,
    );
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.type, 'run.event');
    if (messages[0]?.type === 'run.event') {
      assert.equal(messages[0].event.type, 'run_ack');
      assert.equal(messages[0].event.seq, 0);
    }
    assert.equal(messages[1]?.type, 'run.event');
    if (messages[1]?.type === 'run.event') {
      assert.equal(messages[1].event.type, 'done');
      assert.equal(messages[1].event.seq, 1);
    }
    assert.deepEqual(messages[2], {
      type: 'run.auth.ok',
      requestId: 'auth-live-terminal-before-durable',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });
  } finally {
    cleanupSocketState(replacementSocket, daemonContext);
  }
});

void test('authenticated reconnect fails closed when detached live history cannot be restored', async () => {
  const daemonContext = createRunChannelTestDaemonContext();
  const detachedSocket = createTestSocket();
  const detachedState = getSocketState(detachedSocket);
  detachedState.computerSessionId = daemonContext.computerSessionId;
  const threadId = testThreadId(64);
  const runId = assertRunId('run-live-terminal-restore-failure');
  detachedState.activeRunIds.add(runId);

  await daemonContext.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });
  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: detachedState.computerSessionId,
    sink: createSocketRunEventSink(detachedSocket),
    async persistRunEvents(events) {
      await daemonContext.runCheckpoints.appendRunEvents({
        threadId,
        runId,
        events,
      });
    },
    async readPersistedRunEvents() {
      return [];
    },
  });
  daemonContext.liveRunEvents.publishRunEvent(runId, {
    type: 'run_ack',
    payload: { runId, threadId },
  });
  await daemonContext.liveRunEvents.flushRunEventHistory(runId);
  cleanupSocketState(detachedSocket, daemonContext);
  await daemonContext.liveRunEvents.commitTerminalRunEvent({
    runId,
    event: {
      type: 'done',
      payload: { answer: 'must not be hidden', ok: true },
    },
    async persist(envelope) {
      await daemonContext.runCheckpoints.settleRun({
        threadId,
        runId,
        terminal: {
          eventCursor: envelope.seq,
          event: envelope.event,
        },
      });
    },
  });
  daemonContext.liveRunEvents.finishRun(runId);

  const replacementSocket = createTestSocket();
  const replacementState = getSocketState(replacementSocket);
  replacementState.upgradeAuthorized = true;
  try {
    await handleClientMessage(
      replacementSocket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-live-terminal-restore-failure',
        token: 'proxy-authenticated',
      }),
      daemonContext,
    );

    assert.equal(replacementState.authenticated, false);
    assert.deepEqual(replacementSocket.sentFrames, []);
    assert.deepEqual(replacementSocket.closeCalls, [
      {
        code: 1011,
        reason: 'authentication synchronization failed',
      },
    ]);
    assert.equal(daemonContext.liveRunEvents.hasRun(runId), true);
  } finally {
    cleanupSocketState(replacementSocket, daemonContext);
  }
});
