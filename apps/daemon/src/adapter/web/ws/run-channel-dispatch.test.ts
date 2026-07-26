import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunId, type RunId } from '@geulbat/protocol/ids';
import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { resetShellAuthFailureRateLimitForTests } from '#web/auth/auth-failure-rate-limit.js';
import {
  clearSentMessages,
  createRunChannelTestDaemonContext as createBaseRunChannelTestDaemonContext,
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import { handleClientMessage } from './run-channel-dispatch.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const TEST_DEV_TOKEN = 'test-token-123456';
const TEST_COMPUTER_SESSION_ID = 'computer-session-dispatch-test';
const TEST_PLAN_DRAFT: PlanDraftV1 = {
  schemaVersion: 'plan_draft_v1',
  outcome: 'Ship the approved workflow safely.',
  steps: [
    {
      id: 'step-1',
      text: 'Verify the command dispatch boundary.',
      acceptanceCriteria: [
        'The durable snapshot is published before execution.',
      ],
    },
  ],
  decisions: [],
  assumptions: [],
  openQuestions: [],
};

function createRunChannelTestDaemonContext() {
  const daemonContext = createBaseRunChannelTestDaemonContext();
  daemonContext.computerSessionId = TEST_COMPUTER_SESSION_ID;
  return daemonContext;
}

void test('handleClientMessage rejects invalid websocket JSON', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();

  try {
    await handleClientMessage(socket, '{', daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      status: 400,
      code: 'bad_request',
      message: 'invalid websocket JSON',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage rejects blank requestId before auth', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: '  ',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      status: 400,
      code: 'bad_request',
      message: 'requestId is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage authenticates a socket and rejects duplicate auth', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const state = getSocketState(socket);
  state.authTimeout = setTimeout(() => undefined, 60_000);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-1',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    assert.equal(state.authenticated, true);
    assert.equal(state.computerSessionId, TEST_COMPUTER_SESSION_ID);
    assert.equal(state.authTimeout, null);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.auth.ok',
      requestId: 'auth-1',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-2',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'auth-2',
      status: 409,
      code: 'conflict',
      message: 'socket already authenticated',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage does not authenticate before durable run synchronization finishes', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const state = getSocketState(socket);
  let releaseRecovery: () => void = () => undefined;
  const blockedRecovery = new Promise<never[]>((resolve) => {
    releaseRecovery = () => resolve([]);
  });
  const originalListRunning = daemonContext.runCheckpoints.listRunning;
  daemonContext.runCheckpoints.listRunning = () => blockedRecovery;

  try {
    const authentication = handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-sync-barrier',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );
    await Promise.resolve();

    assert.equal(state.authenticationPending, true);
    assert.equal(state.authenticated, false);
    assert.equal(socket.sentFrames.length, 0);

    releaseRecovery();
    await authentication;

    assert.equal(state.authenticationPending, false);
    assert.equal(state.authenticated, true);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.auth.ok',
      requestId: 'auth-sync-barrier',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });
  } finally {
    daemonContext.runCheckpoints.listRunning = originalListRunning;
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

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
        token: 'cookie-auth',
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

void test('authenticated reconnect restores the current planning workflow snapshot', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(229);
  getSocketState(socket).upgradeAuthorized = true;
  const collecting = await daemonContext.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'deep',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(collecting);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-planning-workflow-reconnect',
        token: 'cookie-auth',
        threadSubscriptions: [threadId],
      }),
      daemonContext,
    );

    const messages = socket.sentFrames.map(
      (frame) => JSON.parse(frame) as RunChannelServerMessage,
    );
    const planningMessage = messages.find(
      (
        message,
      ): message is Extract<
        RunChannelServerMessage,
        { type: 'plan.workflow' }
      > => message.type === 'plan.workflow',
    );
    assert.ok(planningMessage);
    assert.equal(planningMessage.threadId, threadId);
    assert.deepEqual(planningMessage.snapshot, collecting);
    assert.deepEqual(messages[0], {
      type: 'run.auth.ok',
      requestId: 'auth-planning-workflow-reconnect',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('plan approval publishes the exact revision before generated execution and rejects stale revisions', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(230);
  const proposal = await proposeTestPlan(
    daemonContext,
    threadId,
    assertRunId('plan-command-approval-proposal'),
  );
  const socketState = getSocketState(socket);
  socketState.authenticated = true;
  socketState.runStartInFlightRequestId = 'existing-start';

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'plan.command',
        requestId: 'plan-approve',
        request: {
          kind: 'approve',
          threadId,
          workflowId: proposal.workflowId,
          planId: proposal.planId,
          revision: proposal.revision,
          digest: proposal.digest,
        },
      }),
      daemonContext,
    );

    const messages = readSentMessages(socket);
    assert.equal(messages.length, 3);
    const workflowMessage = messages[0];
    assert.equal(workflowMessage?.type, 'plan.workflow');
    if (workflowMessage?.type === 'plan.workflow') {
      assert.equal(workflowMessage.snapshot?.state, 'approved');
    }
    const controlMessage = messages[1];
    assert.equal(controlMessage?.type, 'run.control');
    if (
      controlMessage?.type === 'run.control' &&
      controlMessage.action === 'plan.command'
    ) {
      assert.equal(controlMessage.commandKind, 'approve');
      assert.deepEqual(controlMessage.approvedPlanRef, {
        workflowId: proposal.workflowId,
        planId: proposal.planId,
        revision: proposal.revision,
        digest: proposal.digest,
      });
      assert.equal(controlMessage.snapshot?.state, 'approved');
    }
    assert.deepEqual(messages[2], {
      type: 'run.error',
      requestId: 'plan-approve:plan-approve',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    });

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'plan.command',
        requestId: 'plan-approve-stale',
        request: {
          kind: 'approve',
          threadId,
          workflowId: proposal.workflowId,
          planId: proposal.planId,
          revision: proposal.revision + 1,
          digest: proposal.digest,
        },
      }),
      daemonContext,
    );

    const staleMessages = readSentMessages(socket);
    assert.equal(staleMessages.length, 2);
    assert.equal(staleMessages[0]?.type, 'plan.workflow');
    assert.deepEqual(staleMessages[1], {
      type: 'run.error',
      requestId: 'plan-approve-stale',
      status: 409,
      code: 'conflict',
      message: 'plan revision or digest is no longer current',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('plan revision feedback returns to collection before generated replanning', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(231);
  const proposal = await proposeTestPlan(
    daemonContext,
    threadId,
    assertRunId('plan-command-revision-proposal'),
  );
  const socketState = getSocketState(socket);
  socketState.authenticated = true;
  socketState.runStartInFlightRequestId = 'existing-start';

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'plan.command',
        requestId: 'plan-revise',
        request: {
          kind: 'request_revision',
          threadId,
          workflowId: proposal.workflowId,
          planId: proposal.planId,
          revision: proposal.revision,
          digest: proposal.digest,
          feedback: 'Keep the verification step explicit.',
        },
      }),
      daemonContext,
    );

    const messages = readSentMessages(socket);
    assert.equal(messages.length, 3);
    const workflowMessage = messages[0];
    assert.equal(workflowMessage?.type, 'plan.workflow');
    if (workflowMessage?.type === 'plan.workflow') {
      assert.equal(workflowMessage.snapshot?.state, 'collecting');
      if (workflowMessage.snapshot?.state === 'collecting') {
        assert.equal(
          workflowMessage.snapshot.revisionFeedback,
          'Keep the verification step explicit.',
        );
      }
    }
    const controlMessage = messages[1];
    assert.equal(controlMessage?.type, 'run.control');
    if (
      controlMessage?.type === 'run.control' &&
      controlMessage.action === 'plan.command'
    ) {
      assert.equal(controlMessage.commandKind, 'request_revision');
      assert.equal(controlMessage.snapshot?.state, 'collecting');
    }
    assert.deepEqual(messages[2], {
      type: 'run.error',
      requestId: 'plan-revise:plan-request_revision',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('visual plan explanation preserves the approval card before generated rendering', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(232);
  const proposal = await proposeTestPlan(
    daemonContext,
    threadId,
    assertRunId('plan-command-visual-proposal'),
  );
  const socketState = getSocketState(socket);
  socketState.authenticated = true;
  socketState.runStartInFlightRequestId = 'existing-start';

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'plan.command',
        requestId: 'plan-explain',
        request: {
          kind: 'explain_visual',
          threadId,
          workflowId: proposal.workflowId,
          planId: proposal.planId,
          revision: proposal.revision,
          digest: proposal.digest,
        },
      }),
      daemonContext,
    );

    const messages = readSentMessages(socket);
    assert.equal(messages.length, 3);
    const workflowMessage = messages[0];
    assert.equal(workflowMessage?.type, 'plan.workflow');
    if (workflowMessage?.type === 'plan.workflow') {
      assert.deepEqual(workflowMessage.snapshot, proposal);
    }
    const controlMessage = messages[1];
    assert.equal(controlMessage?.type, 'run.control');
    if (
      controlMessage?.type === 'run.control' &&
      controlMessage.action === 'plan.command'
    ) {
      assert.equal(controlMessage.commandKind, 'explain_visual');
      assert.deepEqual(controlMessage.snapshot, proposal);
    }
    assert.deepEqual(messages[2], {
      type: 'run.error',
      requestId: 'plan-explain:plan-explain_visual',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('Goal pause and resume publish durable state before continuation and report stale commands', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(233);
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Finish the durable Goal.',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  const socketState = getSocketState(socket);
  socketState.authenticated = true;

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'goal.command',
        requestId: 'goal-pause',
        request: {
          kind: 'pause',
          threadId,
          goalId: goal.goalId,
        },
      }),
      daemonContext,
    );

    const pauseMessages = readSentMessages(socket);
    assert.equal(pauseMessages.length, 2);
    assert.equal(pauseMessages[0]?.type, 'goal.state');
    if (pauseMessages[0]?.type === 'goal.state') {
      assert.equal(pauseMessages[0].snapshot?.state, 'paused');
    }
    const pauseControl = pauseMessages[1];
    assert.equal(pauseControl?.type, 'run.control');
    if (
      pauseControl?.type === 'run.control' &&
      pauseControl.action === 'goal.command'
    ) {
      assert.equal(pauseControl.commandKind, 'pause');
      assert.equal(pauseControl.snapshot?.state, 'paused');
    }

    clearSentMessages(socket);
    socketState.runStartInFlightRequestId = 'existing-start';
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'goal.command',
        requestId: 'goal-resume',
        request: {
          kind: 'resume',
          threadId,
          goalId: goal.goalId,
        },
      }),
      daemonContext,
    );

    const resumeMessages = readSentMessages(socket);
    assert.equal(resumeMessages.length, 3);
    assert.equal(resumeMessages[0]?.type, 'goal.state');
    if (resumeMessages[0]?.type === 'goal.state') {
      assert.equal(resumeMessages[0].snapshot?.state, 'paused');
    }
    const resumeControl = resumeMessages[1];
    assert.equal(resumeControl?.type, 'run.control');
    if (
      resumeControl?.type === 'run.control' &&
      resumeControl.action === 'goal.command'
    ) {
      assert.equal(resumeControl.commandKind, 'resume');
      assert.equal(resumeControl.snapshot?.state, 'paused');
    }
    assert.deepEqual(resumeMessages[2], {
      type: 'run.error',
      requestId: 'goal-resume:goal-resume',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    });

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'goal.command',
        requestId: 'goal-stale',
        request: {
          kind: 'resume',
          threadId,
          goalId: `${goal.goalId}-stale`,
        },
      }),
      daemonContext,
    );

    const staleMessages = readSentMessages(socket);
    assert.equal(staleMessages.length, 2);
    assert.equal(staleMessages[0]?.type, 'goal.state');
    assert.deepEqual(staleMessages[1], {
      type: 'run.error',
      requestId: 'goal-stale',
      status: 409,
      code: 'conflict',
      message: 'Goal is not current',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
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
        token: 'cookie-auth',
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

void test('handleClientMessage durably acknowledges only the matching terminal event cursor', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(62);
  const runId = assertRunId('run-terminal-event-ack');
  getSocketState(socket).authenticated = true;

  try {
    await daemonContext.runCheckpoints.startRun({
      threadId,
      runId,
      request: { workingDirectory: '', permissionMode: 'basic' },
    });
    await daemonContext.runCheckpoints.settleRun({
      threadId,
      runId,
      terminal: {
        eventCursor: 5,
        event: {
          type: 'done',
          payload: { answer: 'done', ok: true },
        },
      },
    });

    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.event.ack',
        requestId: 'req-terminal-event-ack',
        request: { threadId, runId, seq: 5 },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'req-terminal-event-ack',
      action: 'run.event.ack',
      ok: true,
      seq: 5,
    });
    assert.equal(
      (await daemonContext.runCheckpoints.readThread(threadId))?.terminal
        ?.acknowledged,
      true,
    );
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
    sink: () => true,
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
        token: 'cookie-auth',
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

void test('handleClientMessage authenticates sockets that were authorized during websocket upgrade', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const state = getSocketState(socket);
  state.upgradeAuthorized = true;
  state.authTimeout = setTimeout(() => undefined, 60_000);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-cookie-upgrade',
        token: 'cookie-auth',
      }),
      daemonContext,
    );

    assert.equal(state.authenticated, true);
    assert.equal(state.authTimeout, null);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.auth.ok',
      requestId: 'auth-cookie-upgrade',
      ok: true,
      computerSessionId: TEST_COMPUTER_SESSION_ID,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage closes unauthorized sockets for invalid auth tokens', async () => {
  resetShellAuthFailureRateLimitForTests();
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  getSocketState(socket).remoteAddress = '127.0.0.31';

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-invalid',
        token: 'wrong-token-123456',
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'auth-invalid',
      status: 401,
      code: 'unauthorized',
      message: 'invalid websocket auth token',
    });
    assert.deepEqual(socket.closeCalls, [
      { code: 1008, reason: 'unauthorized' },
    ]);
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage rate limits repeated websocket auth failures from the same client', async () => {
  resetShellAuthFailureRateLimitForTests();
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createRunChannelTestDaemonContext();

  try {
    for (let index = 0; index < 8; index += 1) {
      const socket = createTestSocket();
      getSocketState(socket).remoteAddress = '127.0.0.41';
      await handleClientMessage(
        socket,
        JSON.stringify({
          type: 'run.auth',
          requestId: `auth-invalid-${index}`,
          token: 'wrong-token-123456',
        }),
        daemonContext,
      );

      assert.deepEqual(readLastSentMessage(socket), {
        type: 'run.error',
        requestId: `auth-invalid-${index}`,
        status: 401,
        code: 'unauthorized',
        message: 'invalid websocket auth token',
      });
      cleanupSocketState(socket, daemonContext);
    }

    const limitedSocket = createTestSocket();
    getSocketState(limitedSocket).remoteAddress = '127.0.0.41';
    await handleClientMessage(
      limitedSocket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-limited',
        token: 'wrong-token-123456',
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(limitedSocket), {
      type: 'run.error',
      requestId: 'auth-limited',
      status: 429,
      code: 'rate_limited',
      message: 'too many authentication failures; retry later',
    });
    assert.deepEqual(limitedSocket.closeCalls, [
      { code: 1008, reason: 'rate_limited' },
    ]);
    cleanupSocketState(limitedSocket, daemonContext);
  } finally {
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage closes unauthenticated sockets for run messages', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-no-auth',
        request: {
          prompt: 'hello',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-no-auth',
      status: 401,
      code: 'unauthorized',
      message: 'websocket authentication required',
    });
    assert.deepEqual(socket.closeCalls, [
      { code: 1008, reason: 'unauthorized' },
    ]);
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage routes authenticated run.start validation errors through executeRunRequest', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-start',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-empty-prompt',
        request: {
          prompt: '   ',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-empty-prompt',
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage rejects a second same-socket run.start while another start is in flight', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-inflight',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    getSocketState(socket).runStartInFlightRequestId = 'start-first';
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-second',
        request: {
          prompt: 'hello',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-second',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage routes run.interject to the durable active run buffer', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(142);
  const startedRun = startManagedRun(
    {
      runId: 'interject-dispatch-owned',
      runContext: {
        threadId,
        stateRoot: daemonContext.homeStateRoot,
        workingDirectory: '',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  if (!startedRun.ok) {
    assert.fail(`expected run to start; active run: ${startedRun.activeRunId}`);
  }
  await daemonContext.runCheckpoints.startRun({
    runId: startedRun.runId,
    threadId,
    request: { workingDirectory: '', permissionMode: 'basic' },
  });

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-interject-enabled',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );
    getSocketState(socket).activeRunIds.add(startedRun.runId);

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.interject',
        requestId: 'interject-enabled',
        request: {
          runId: startedRun.runId,
          text: 'route this into the live run',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'interject-enabled',
      action: 'run.interject',
      ok: true,
      receivedSeq: 1,
      bufferDepth: 1,
    });
    assert.deepEqual(startedRun.runState.interject.items, [
      { receivedSeq: 1, text: 'route this into the live run' },
    ]);
    assert.deepEqual(
      (await daemonContext.runCheckpoints.readThread(threadId))
        ?.pendingInterjects,
      [{ receivedSeq: 1, text: 'route this into the live run' }],
    );
  } finally {
    startedRun.finish();
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage preserves requestId when run.cancel dispatch throws unexpectedly', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const runId = 'run-cancel-dispatch-throw' as RunId;
  const socketState = getSocketState(socket);
  socketState.authenticated = true;
  socketState.activeRunIds.add(runId);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  const originalGetRunById = daemonContext.activeRuns.getRunById;
  daemonContext.activeRuns.getRunById = (() => {
    throw new Error('boom');
  }) as typeof daemonContext.activeRuns.getRunById;

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.cancel',
        requestId: 'cancel-throw',
        request: { runId },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-throw',
      status: 500,
      code: 'internal',
      message: 'internal server error',
    });
    const dispatchLog = errors.find((entry) =>
      String(entry[0]).includes(
        '[run-channel/dispatch] unexpected websocket message dispatch error:',
      ),
    );
    assert.ok(dispatchLog);
    const logLine = String(dispatchLog[0]);
    assert.match(logLine, /messageType="run.cancel"/);
    assert.match(logLine, /requestId="cancel-throw"/);
    assert.match(logLine, /runId="run-cancel-dispatch-throw"/);
  } finally {
    console.error = originalError;
    daemonContext.activeRuns.getRunById = originalGetRunById;
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleClientMessage preserves requestId when run.start setup throws unexpectedly', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const originalTryStartRun = daemonContext.activeRuns.tryStartRun;
  daemonContext.activeRuns.tryStartRun = (() => {
    throw new Error('boom');
  }) as typeof daemonContext.activeRuns.tryStartRun;
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-start-throw',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-throw',
        request: {
          prompt: 'hello',
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-throw',
      status: 500,
      code: 'internal',
      message: 'internal server error',
    });
    assert.equal(getSocketState(socket).runStartInFlightRequestId, null);
    const dispatchLog = errors.find((entry) =>
      String(entry[0]).includes(
        '[run-channel/dispatch] unexpected run.start dispatch error:',
      ),
    );
    assert.ok(dispatchLog);
    const logLine = String(dispatchLog[0]);
    assert.match(logLine, /messageType="run.start"/);
    assert.doesNotMatch(logLine, /projectId=/u);
    assert.match(logLine, /requestId="start-throw"/);
  } finally {
    console.error = originalError;
    daemonContext.activeRuns.tryStartRun = originalTryStartRun;
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

void test('handleClientMessage can route run.start through an injected active-run store', async () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = TEST_DEV_TOKEN;
  const daemonContext = createRunChannelTestDaemonContext();
  const socket = createTestSocket();
  const threadId = testThreadId(141);
  const existingRun = startManagedRun(
    {
      runId: 'existing-run-dispatch-local',
      runContext: {
        threadId,
        stateRoot: daemonContext.homeStateRoot,
        workingDirectory: '',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  assert.equal(existingRun.ok, true);

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-local-start',
        token: TEST_DEV_TOKEN,
      }),
      daemonContext,
    );

    clearSentMessages(socket);
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.start',
        requestId: 'start-local-conflict',
        request: {
          prompt: 'hello',
          threadId,
        },
      }),
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'start-local-conflict',
      status: 409,
      code: 'conflict_active_run',
      message: `thread ${threadId} already has an active run`,
    });
  } finally {
    if (existingRun.ok) {
      existingRun.finish();
    }
    cleanupSocketState(socket, daemonContext);
    restoreEnv('GEULBAT_DEV_TOKEN', previousDevToken);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function proposeTestPlan(
  daemonContext: ReturnType<typeof createRunChannelTestDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  proposalRunId: RunId,
) {
  const collecting = await daemonContext.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'deep',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(collecting);
  return await daemonContext.planningWorkflows.propose({
    threadId,
    proposalRunId,
    draft: TEST_PLAN_DRAFT,
  });
}

function readSentMessages(
  socket: ReturnType<typeof createTestSocket>,
): RunChannelServerMessage[] {
  return socket.sentFrames.map(
    (frame) => JSON.parse(frame) as RunChannelServerMessage,
  );
}
