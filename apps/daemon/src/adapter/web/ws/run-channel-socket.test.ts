import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRunId, type RunId } from '@geulbat/protocol/ids';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import WebSocket from 'ws';

import { rejectUpgrade, sendMessage } from './run-channel-socket.js';
import {
  bindSocketRuns,
  cleanupSocketState,
  createSocketRunEventSink,
  ensureThreadBackgroundSubscription,
  getSocketState,
  nextSocketThreadSeq,
  socketOwnsRun,
  trackSocketMessageDispatch,
} from './run-channel-socket-runtime.js';
import {
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { createRunInterjectBuffer } from '../../../daemon/sessions/active-run-interject-buffer.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { createDaemonRuntimeStateStore } from '../../../daemon/runtime-state-store.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { TEST_CHILD_MODEL_REGISTRATION } from '../../../test-support/subagent-model-routing.js';

void test('sendMessage sends only while the websocket is open', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    sendMessage(socket, {
      type: 'run.auth.ok',
      requestId: 'auth-ok',
      ok: true,
      computerSessionId: daemonContext.computerSessionId,
    });
    assert.equal(socket.sentFrames.length, 1);

    socket.readyState = WebSocket.CLOSING;
    sendMessage(socket, {
      type: 'run.auth.ok',
      requestId: 'ignored',
      ok: true,
      computerSessionId: daemonContext.computerSessionId,
    });
    assert.equal(socket.sentFrames.length, 1);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('socket run event sink sends transient output without a cursor', () => {
  const socket = createTestSocket();
  const runId = assertRunId('123e4567-e89b-42d3-a456-426614174021');
  const threadId = testThreadId(21);
  const sink = createSocketRunEventSink(socket);

  assert.equal(
    sink.transient?.({
      runId,
      threadId,
      event: {
        type: 'tool_output_delta',
        payload: {
          callId: 'call-exec',
          tool: 'exec_command',
          stream: 'stderr',
          text: 'still running',
        },
      },
    }),
    true,
  );
  assert.deepEqual(readLastSentMessage(socket), {
    type: 'run.tool.output.delta',
    runId,
    threadId,
    payload: {
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stderr',
      text: 'still running',
    },
  });
});

void test('socket run event delivery releases active delivery but retains socket ownership after terminal', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const state = getSocketState(socket);
  const runId = testRunId('terminal-delivery-owner');
  const threadId = testThreadId(20);
  const sink = createSocketRunEventSink(socket);
  state.activeRunIds.add(runId);
  state.ownedRunIds.add(runId);

  try {
    assert.equal(
      sink({
        runId,
        threadId,
        seq: 0,
        event: {
          type: 'commentary_delta',
          payload: { text: 'still running' },
        },
      }),
      true,
    );
    assert.equal(state.activeRunIds.has(runId), true);

    assert.equal(
      sink({
        runId,
        threadId,
        seq: 1,
        event: {
          type: 'done',
          payload: { answer: 'finished', ok: true },
        },
      }),
      true,
    );
    assert.equal(state.activeRunIds.has(runId), false);
    assert.equal(state.ownedRunIds.has(runId), true);
    assert.equal(socketOwnsRun(socket, runId), true);

    state.activeRunIds.add(runId);
    socket.readyState = WebSocket.CLOSING;
    assert.equal(
      sink({
        runId,
        threadId,
        seq: 2,
        event: {
          type: 'error',
          payload: { code: 'internal', message: 'not delivered' },
        },
      }),
      false,
    );
    assert.equal(state.activeRunIds.has(runId), true);
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
        capabilities: ['ptc'],
        toolSurface: 'explorer_ptc',
        terminalState: 'completed',
        result: 'done',
        resultRef: 'subagent-result:delivery-live',
        resultDigest: `sha256:${'a'.repeat(64)}`,
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
        resultDeliveryState: 'pending',
        parentRunId,
        childRunId,
        subagentType: 'explorer',
        capabilities: ['ptc'],
        toolSurface: 'explorer_ptc',
        terminalState: 'completed',
        ok: true,
        result: 'done',
        resultRef: 'subagent-result:delivery-live',
        resultDigest: `sha256:${'a'.repeat(64)}`,
        completedAt: '2026-03-30T00:00:00.000Z',
      });
    }

    daemonContext.backgroundNotifications.acknowledgeThreadBackgroundResults(
      threadId,
      ['delivery-live'],
    );
    const acknowledgedMessage = readLastSentMessage(socket);
    assert.equal(acknowledgedMessage?.type, 'run.event');
    if (
      acknowledgedMessage?.type === 'run.event' &&
      acknowledgedMessage.event.type === 'subagent_terminal'
    ) {
      assert.equal(acknowledgedMessage.event.seq, 1);
      assert.equal(
        acknowledgedMessage.event.payload.resultDeliveryState,
        'acknowledged',
      );
      assert.equal(
        acknowledgedMessage.event.payload.deliveryId,
        'delivery-live',
      );
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('ensureThreadBackgroundSubscription forwards durable result reports with their original result address', async () => {
  const socket = createTestSocket();
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-socket-result-report-'),
  );
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot,
  });
  const daemonContext = createDaemonContext({
    homeStateRoot,
    subagentTerminalDeliveries: runtimeStateStore,
  });
  const threadId = testThreadId(24);

  try {
    ensureThreadBackgroundSubscription(socket, threadId, daemonContext);
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
      threadId,
      {
        deliveryId: 'delivery-report',
        parentRunId: testRunId('parent-report'),
        childRunId: testRunId('child-report'),
        subagentType: 'worker',
        terminalState: 'completed',
        result: '정확한 원문 결과',
        resultReportSummary: '원문을 보존한 짧은 결과 보고',
        completedAt: '2026-07-27T00:00:00.000Z',
      },
    );

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (
      message?.type === 'run.event' &&
      message.event.type === 'subagent_terminal'
    ) {
      assert.deepEqual(message.event.payload.resultReport, {
        summary: '원문을 보존한 짧은 결과 보고',
        sourceResultRef: message.event.payload.resultRef,
        sourceResultDigest: message.event.payload.resultDigest,
      });
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
    runtimeStateStore.close();
  }
});

void test('bindSocketRuns restores active background children even after their parent run settled', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(226);
  const childThreadId = testThreadId(227);
  const parentRunId = testRunId('parent-settled-before-reconnect');
  const childRunId = testRunId('child-still-running-after-reconnect');

  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    parentRunId,
    ownerThreadId,
    childRunId,
    childThreadId,
    subagentType: 'explorer',
    capabilities: ['ptc'],
  });
  const childRuntime = daemonContext.childRuns.getChildRun(childRunId)?.runtime;
  assert.ok(childRuntime);

  try {
    assert.equal(await bindSocketRuns(socket, daemonContext), 0);
    assert.equal(
      getSocketState(socket).threadUnsubscribes.has(ownerThreadId),
      true,
    );
    assert.equal(socketOwnsRun(socket, parentRunId), true);

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (message?.type === 'run.event') {
      assert.equal(message.event.type, 'subagent_spawned');
      assert.equal(message.event.runId, parentRunId);
      assert.equal(message.event.threadId, ownerThreadId);
      assert.deepEqual(message.event.payload, {
        parentRunId,
        childRunId,
        childThreadId,
        subagentType: 'explorer',
        capabilities: ['ptc'],
        toolSurface: 'explorer_ptc',
        modelId: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        selectionSource: 'inherited',
        runtime: childRuntime,
      });
    }

    daemonContext.childRuns.updateChildRuntime({
      childRunId,
      runtime: {
        phase: 'tool_running',
        observedAt: '2026-07-23T10:28:00.000Z',
        lastTool: {
          name: 'read_file',
          callId: 'call-read-1',
          state: 'running',
        },
        partialOutputAvailable: false,
      },
    });
    const statusMessage = readLastSentMessage(socket);
    assert.equal(statusMessage?.type, 'run.event');
    if (statusMessage?.type === 'run.event') {
      assert.equal(statusMessage.event.type, 'subagent_status');
      if (statusMessage.event.type === 'subagent_status') {
        assert.deepEqual(statusMessage.event.payload.runtime, {
          phase: 'tool_running',
          observedAt: '2026-07-23T10:28:00.000Z',
          lastTool: {
            name: 'read_file',
            callId: 'call-read-1',
            state: 'running',
          },
          partialOutputAvailable: false,
        });
        assert.equal(statusMessage.event.payload.modelId, 'gpt-5.6-sol');
      }
    }
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('bindSocketRuns replays a pending terminal child result when only the settled parent can identify its thread', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(228);
  const parentRunId = testRunId('settled-parent-terminal-child-replay');
  const childRunId = testRunId('interrupted-child-after-daemon-restart');
  const previousOwnerId = 'socket-before-daemon-restart';

  daemonContext.liveRunEvents.startRun({
    runId: parentRunId,
    threadId: ownerThreadId,
    ownerId: previousOwnerId,
    sink: () => true,
    async persistRunEvents() {},
  });
  daemonContext.liveRunEvents.detachOwner(previousOwnerId);
  daemonContext.liveRunEvents.finishRun(parentRunId);
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    ownerThreadId,
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
    assert.equal(await bindSocketRuns(socket, daemonContext), 1);
    assert.equal(socketOwnsRun(socket, parentRunId), true);

    const message = readLastSentMessage(socket);
    assert.equal(message?.type, 'run.event');
    if (
      message?.type === 'run.event' &&
      message.event.type === 'subagent_terminal'
    ) {
      assert.equal(
        message.event.payload.deliveryId,
        'delivery-after-daemon-restart',
      );
      assert.equal(message.event.payload.parentRunId, parentRunId);
      assert.equal(message.event.payload.childRunId, childRunId);
      assert.equal(message.event.payload.terminalState, 'failed');
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
        resultRef: 'subagent-result:delivery-local',
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
        assert.equal(
          message.event.payload.resultRef,
          'subagent-result:delivery-local',
        );
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

void test('cleanupSocketState clears socket-local state and detaches active run delivery', async () => {
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
  state.ownedRunIds.add(runId);
  daemonContext.liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: state.computerSessionId,
    sink: () => true,
    async persistRunEvents() {},
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
    assert.notEqual(nextState.computerSessionId, state.computerSessionId);
    assert.equal(nextState.activeRunIds.size, 0);
    assert.equal(nextState.ownedRunIds.size, 0);

    assert.deepEqual(
      daemonContext.liveRunEvents.publishRunEvent(runId, {
        type: 'commentary_delta',
        payload: { text: 'continued after socket cleanup' },
      }),
      { seq: 0, delivery: 'buffered' },
    );
    const deliveredSeqs: number[] = [];
    assert.deepEqual(
      await daemonContext.liveRunEvents.bindRuns({
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
          previousOwnerId: state.computerSessionId,
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

void test('cleanupSocketState keeps pending approvals resolvable after reconnect', async () => {
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
  let notifyPending = () => undefined as void;
  const pendingRecorded = new Promise<void>((resolve) => {
    notifyPending = resolve;
  });
  const wait = daemonContext.approvalGate.waitForApproval(
    'call-socket-cleanup',
    runId,
    threadId,
    {
      runId,
      computerSessionId: state.computerSessionId,
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    new AbortController().signal,
    () => notifyPending(),
  );
  await pendingRecorded;

  // 소켓이 끊겨도 승인 대기/grant는 세션 소유라 살아남는다 — 재연결한
  // 소켓이 그대로 결정을 내릴 수 있어야 한다 (오너 결정 2026-07-23).
  cleanupSocketState(socket, daemonContext);

  assert.equal(
    await daemonContext.approvalGate.resolveApproval(
      'call-socket-cleanup',
      runId,
      threadId,
      'approved',
    ),
    'resolved',
  );
  assert.equal(await wait, 'approved');
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
