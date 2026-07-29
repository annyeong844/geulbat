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
import {
  clearSentMessages,
  createRunChannelTestDaemonContext as createBaseRunChannelTestDaemonContext,
  createTestSocket,
} from '../../../test-support/run-channel-test-support.js';
import { handleClientMessage } from './run-channel-dispatch.js';
import { testThreadId } from '../../../test-support/thread-id.js';

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

void test('authenticated reconnect restores the current canonical planning draft', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(229);
  getSocketState(socket).upgradeAuthorized = true;
  const proposal = await proposeTestPlan(
    daemonContext,
    threadId,
    assertRunId('plan-reconnect-canonical-draft'),
  );

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.auth',
        requestId: 'auth-planning-workflow-reconnect',
        token: 'proxy-authenticated',
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
    assert.deepEqual(planningMessage.snapshot, proposal);
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

void test('plan revision interrupts visual work and waits for that thread before generated replanning', async () => {
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
  const visualRun = startManagedRun(
    {
      runId: 'plan-command-active-visual',
      runContext: {
        threadId,
        stateRoot: daemonContext.homeStateRoot,
        workingDirectory: '/workspace',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  if (!visualRun.ok) {
    assert.fail(`expected visual run to start: ${visualRun.activeRunId}`);
  }

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
    assert.equal(messages.length, 2);
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
    assert.equal(visualRun.runState.abortController.signal.aborted, true);

    visualRun.finish();
    await Promise.resolve();
    await daemonContext.planningWorkflows.readThread(threadId);
    await Promise.resolve();
    const settledMessages = readSentMessages(socket);
    assert.equal(settledMessages.length, 3);
    assert.deepEqual(settledMessages[2], {
      type: 'run.error',
      requestId: 'plan-revise:plan-request_revision',
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    });
  } finally {
    visualRun.finish();
    cleanupSocketState(socket, daemonContext);
  }
});

void test('plan cancellation interrupts active visual work without starting a replacement run', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(234);
  const proposal = await proposeTestPlan(
    daemonContext,
    threadId,
    assertRunId('plan-command-cancel-proposal'),
  );
  const socketState = getSocketState(socket);
  socketState.authenticated = true;
  const visualRun = startManagedRun(
    {
      runId: 'plan-command-cancel-active-visual',
      runContext: {
        threadId,
        stateRoot: daemonContext.homeStateRoot,
        workingDirectory: '/workspace',
      },
    },
    { activeRuns: daemonContext.activeRuns },
  );
  if (!visualRun.ok) {
    assert.fail(`expected visual run to start: ${visualRun.activeRunId}`);
  }

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'plan.command',
        requestId: 'plan-cancel-visual',
        request: {
          kind: 'cancel',
          threadId,
          workflowId: proposal.workflowId,
          planId: proposal.planId,
          revision: proposal.revision,
        },
      }),
      daemonContext,
    );

    assert.equal(visualRun.runState.abortController.signal.aborted, true);
    const messages = readSentMessages(socket);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], {
      type: 'plan.workflow',
      threadId,
      snapshot: null,
    });
    assert.deepEqual(messages[1], {
      type: 'run.control',
      requestId: 'plan-cancel-visual',
      action: 'plan.command',
      ok: true,
      commandKind: 'cancel',
      snapshot: null,
    });

    visualRun.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readSentMessages(socket).length, 2);
  } finally {
    visualRun.finish();
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

    await daemonContext.planningWorkflows.readThread(threadId);
    await Promise.resolve();
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

void test('authenticated thread subscription publishes current workflow and Goal snapshots without starting a run', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(62_3);
  getSocketState(socket).authenticated = true;

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'run.thread.subscribe',
        requestId: 'subscribe-current-thread-state',
        request: { threadId },
      }),
      daemonContext,
    );

    assert.deepEqual(readSentMessages(socket), [
      {
        type: 'plan.workflow',
        threadId,
        snapshot: null,
      },
      {
        type: 'goal.state',
        threadId,
        snapshot: null,
      },
    ]);
    assert.equal(
      daemonContext.activeRuns.getRunByThreadId(threadId),
      undefined,
    );
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('Goal command reports an internal store failure after republishing the durable snapshot', async () => {
  const socket = createTestSocket();
  const daemonContext = createRunChannelTestDaemonContext();
  const threadId = testThreadId(62_4);
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Keep the durable Goal visible.',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  getSocketState(socket).authenticated = true;
  const applyCommand = daemonContext.goals.applyCommand.bind(
    daemonContext.goals,
  );
  daemonContext.goals.applyCommand = async () => {
    throw new Error('goal store unavailable');
  };

  try {
    await handleClientMessage(
      socket,
      JSON.stringify({
        type: 'goal.command',
        requestId: 'goal-store-failure',
        request: {
          kind: 'pause',
          threadId,
          goalId: goal.goalId,
        },
      }),
      daemonContext,
    );

    const messages = readSentMessages(socket);
    assert.equal(messages[0]?.type, 'goal.state');
    assert.deepEqual(messages[1], {
      type: 'run.error',
      requestId: 'goal-store-failure',
      status: 500,
      code: 'internal',
      message: 'goal store unavailable',
    });
  } finally {
    daemonContext.goals.applyCommand = applyCommand;
    cleanupSocketState(socket, daemonContext);
  }
});

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
