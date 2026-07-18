import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunId } from '@geulbat/protocol/ids';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import WebSocket from 'ws';

import { rejectUpgrade, sendMessage } from './run-channel-socket.js';
import {
  cleanupSocketState,
  ensureThreadBackgroundSubscription,
  getSocketState,
  nextSocketThreadSeq,
  trackSocketMessageDispatch,
} from './run-channel-socket-runtime.js';
import {
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { createRunInterjectBuffer } from '../../../daemon/sessions/active-run-interject-buffer.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('sendMessage sends only while the websocket is open', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    sendMessage(socket, {
      type: 'run.auth.ok',
      requestId: 'auth-ok',
      ok: true,
    });
    assert.equal(socket.sentFrames.length, 1);

    socket.readyState = WebSocket.CLOSING;
    sendMessage(socket, {
      type: 'run.auth.ok',
      requestId: 'ignored',
      ok: true,
    });
    assert.equal(socket.sentFrames.length, 1);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('nextSocketThreadSeq increments independently per thread', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadA = testThreadId(21);
  const threadB = testThreadId(22);

  try {
    assert.equal(nextSocketThreadSeq(socket, threadA), 0);
    assert.equal(nextSocketThreadSeq(socket, threadA), 1);
    assert.equal(nextSocketThreadSeq(socket, threadB), 0);
    assert.equal(nextSocketThreadSeq(socket, threadB), 1);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('ensureThreadBackgroundSubscription subscribes once and forwards background run events', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(23);
  const parentRunId = testRunId('parent-1');
  const childRunId = testRunId('background-child-1');

  try {
    ensureThreadBackgroundSubscription(socket, threadId, daemonContext);
    ensureThreadBackgroundSubscription(socket, threadId, daemonContext);
    assert.equal(getSocketState(socket).threadUnsubscribes.size, 1);

    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
      threadId,
      {
        deliveryId: 'delivery-live',
        parentRunId,
        childRunId,
        subagentType: 'explorer',
        terminalState: 'completed',
        result: 'done',
        completedAt: '2026-03-30T00:00:00.000Z',
      },
    );

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (message?.type === 'run.event') {
      assert.equal(message.event.type, 'subagent_terminal');
      assert.equal(message.event.threadId, threadId);
      assert.equal(message.event.seq, 0);
      assert.deepEqual(message.event.payload, {
        deliveryId: 'delivery-live',
        parentRunId,
        childRunId,
        subagentType: 'explorer',
        terminalState: 'completed',
        ok: true,
        result: 'done',
      });
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('ensureThreadBackgroundSubscription can use an injected background queue', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(123);
  const childRunId = testRunId('background-child-local');

  try {
    ensureThreadBackgroundSubscription(socket, threadId, daemonContext);
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
      threadId,
      {
        deliveryId: 'delivery-local',
        parentRunId: testRunId('parent-2'),
        childRunId,
        subagentType: 'explorer',
        terminalState: 'completed',
        result: 'done',
        completedAt: '2026-03-30T00:00:00.000Z',
      },
    );

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (message?.type === 'run.event') {
      assert.equal(message.event.type, 'subagent_terminal');
      if (message.event.type === 'subagent_terminal') {
        assert.equal(message.event.payload.deliveryId, 'delivery-local');
        assert.equal(message.event.payload.childRunId, childRunId);
      }
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('ensureThreadBackgroundSubscription replays pending background results on subscribe', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(223);
  const childRunId = testRunId('background-child-replay');

  try {
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
      threadId,
      {
        deliveryId: 'delivery-replay',
        parentRunId: testRunId('parent-replay'),
        childRunId,
        subagentType: 'explorer',
        terminalState: 'completed',
        result: 'done',
        completedAt: '2026-03-30T00:00:09.000Z',
      },
    );

    ensureThreadBackgroundSubscription(socket, threadId, daemonContext);

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (
      message?.type === 'run.event' &&
      message.event.type === 'subagent_terminal'
    ) {
      assert.equal(message.event.payload.deliveryId, 'delivery-replay');
      assert.equal(message.event.payload.childRunId, childRunId);
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('cleanupSocketState clears socket-local state and detaches active run delivery', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(24);
  const runId = 'run-socket-cleanup' as RunId;
  const abortController = new AbortController();
  const state = getSocketState(socket);
  state.authTimeout = setTimeout(() => undefined, 60_000);
  state.heartbeatInterval = setInterval(() => undefined, 60_000);
  state.heartbeatTimeout = setTimeout(() => undefined, 60_000);
  state.awaitingPong = true;

  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  state.activeRunIds.add(runId);
  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: state.approvalSessionId,
    sink: () => true,
  });
  ensureThreadBackgroundSubscription(socket, threadId, daemonContext);
  nextSocketThreadSeq(socket, threadId);

  try {
    cleanupSocketState(socket, daemonContext);

    assert.equal(abortController.signal.aborted, false);
    assert.equal(state.threadUnsubscribes.size, 0);
    assert.equal(state.threadSeqByThread.size, 0);
    assert.equal(state.heartbeatInterval, null);
    assert.equal(state.heartbeatTimeout, null);
    assert.equal(state.awaitingPong, false);

    const nextState = getSocketState(socket);
    assert.notEqual(nextState.approvalSessionId, state.approvalSessionId);
    assert.equal(nextState.activeRunIds.size, 0);

    assert.deepEqual(
      daemonContext.liveRunEvents.publishRunEvent(runId, {
        type: 'commentary_delta',
        payload: { text: 'continued after socket cleanup' },
      }),
      { seq: 0, delivery: 'buffered' },
    );
    const deliveredSeqs: number[] = [];
    assert.deepEqual(
      daemonContext.liveRunEvents.bindDetachedRuns({
        ownerId: 'replacement-socket-session',
        sink: (envelope) => {
          deliveredSeqs.push(envelope.seq);
          return true;
        },
      }),
      [
        {
          runId,
          threadId,
          previousOwnerId: state.approvalSessionId,
          terminal: false,
        },
      ],
    );
    assert.deepEqual(deliveredSeqs, [0]);
  } finally {
    daemonContext.liveRunEvents.finishRun(runId);
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('cleanupSocketState keeps closed socket state until in-flight message dispatches settle', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const state = getSocketState(socket);
  let resolveDispatch: () => void = () => undefined;
  const dispatch = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });

  trackSocketMessageDispatch(socket, dispatch);

  cleanupSocketState(socket, daemonContext);

  assert.equal(state.closed, true);
  assert.equal(getSocketState(socket), state);

  resolveDispatch();
  await dispatch;
  await Promise.resolve();

  const nextState = getSocketState(socket);
  assert.notEqual(nextState, state);
  assert.equal(nextState.closed, false);

  cleanupSocketState(socket, daemonContext);
});

void test('cleanupSocketState preserves parent and background child runs after disconnect', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(224);
  const childThreadId = testThreadId(225);
  const parentRunId = 'run-socket-parent-cleanup' as RunId;
  const childRunId = 'run-socket-child-cleanup' as RunId;
  const parentAbortController = new AbortController();
  const childAbortController = new AbortController();
  const state = getSocketState(socket);

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(ownerThreadId, {
      runId: parentRunId,
      ...makeRunContext({ threadId: ownerThreadId }),
      ownerThreadId,
      abortController: parentAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(childThreadId, {
      runId: childRunId,
      ...makeRunContext({ threadId: childThreadId }),
      ownerThreadId,
      abortController: childAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );
  state.activeRunIds.add(parentRunId);
  ensureThreadBackgroundSubscription(socket, ownerThreadId, daemonContext);

  try {
    cleanupSocketState(socket, daemonContext);

    assert.equal(parentAbortController.signal.aborted, false);
    assert.equal(childAbortController.signal.aborted, false);
  } finally {
    daemonContext.activeRuns.finishRun(ownerThreadId, parentRunId);
    daemonContext.activeRuns.finishRun(childThreadId, childRunId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('cleanupSocketState clears local runtime stores while preserving the active run', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(124);
  const runId = 'run-socket-local-cleanup' as RunId;
  const abortController = new AbortController();
  const state = getSocketState(socket);
  state.authTimeout = setTimeout(() => undefined, 60_000);
  state.heartbeatInterval = setInterval(() => undefined, 60_000);
  state.heartbeatTimeout = setTimeout(() => undefined, 60_000);
  state.awaitingPong = true;
  state.runStartInFlightRequestId = 'request-socket-local-cleanup';

  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  state.activeRunIds.add(runId);
  ensureThreadBackgroundSubscription(socket, threadId, daemonContext);

  try {
    cleanupSocketState(socket, daemonContext);

    assert.equal(abortController.signal.aborted, false);
    assert.equal(daemonContext.activeRuns.getRunById(runId)?.aborted, false);
    assert.equal(state.activeRunIds.size, 0);
    assert.equal(state.runStartInFlightRequestId, null);
    assert.equal(state.heartbeatInterval, null);
    assert.equal(state.heartbeatTimeout, null);
    assert.equal(state.awaitingPong, false);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('cleanupSocketState clears approval session runtime state', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext({
    homeStateRoot: await mkdtemp(join(tmpdir(), 'geulbat-socket-approval-')),
  });
  const state = getSocketState(socket);
  const threadId = testThreadId(125);
  const runId = testRunId('socket-approval-cleanup');
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  const wait = daemonContext.approvalGate.waitForApproval(
    'call-socket-cleanup',
    runId,
    threadId,
    {
      runId,
      sessionId: state.approvalSessionId,
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    new AbortController().signal,
  );

  cleanupSocketState(socket, daemonContext);

  assert.equal(await wait, 'aborted');
  assert.equal(
    await daemonContext.approvalGate.resolveApproval(
      'call-socket-cleanup',
      runId,
      threadId,
      'approved',
    ),
    'not_found',
  );
  cleanupSocketState(socket, daemonContext);
});

void test('rejectUpgrade writes an HTTP response and destroys the socket', () => {
  const writes: string[] = [];
  let destroyed = false;

  rejectUpgrade(
    {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      destroy() {
        destroyed = true;
      },
    },
    403,
    'Forbidden',
    'origin not allowed',
  );

  assert.equal(destroyed, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? '', /^HTTP\/1\.1 403 Forbidden/m);
  assert.match(writes[0] ?? '', /origin not allowed$/m);
});
