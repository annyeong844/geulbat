import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256Digest } from '@geulbat/content-identity/sha256';
import { AGENT_WAIT_APPROVAL_BLOCKED_REASON } from '@geulbat/protocol/run-events';

import { waitForAgentChildren } from '../agent-child-wait.js';
import { agentWaitTool } from './agent-wait.js';
import { createDaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import { createChildRunRegistry } from '../../agent/runtime/child-run-registry.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import {
  pushPendingInterject,
  requestInterjectFlush,
} from '../../sessions/active-run-interject-buffer.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_CHILD_MODEL_REGISTRATION,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import type { ThreadId } from '@geulbat/protocol/ids';

function createWaitContext(args?: {
  daemonContext?: ReturnType<typeof createDaemonContext>;
  runId?: string;
  threadId?: ThreadId;
}) {
  const daemonContext = args?.daemonContext ?? createDaemonContext();
  const threadId = args?.threadId ?? testThreadId(1);
  const runId = args?.runId ?? testRunId('parent-run');
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId }),
  });
  return {
    daemonContext,
    runState,
    executionContext: {
      callId: 'call-wait',
      workspaceRoot: '/tmp/workspace',
      runId,
      threadId,
      runtimeServices: daemonContext,
      runState,
      interjectBuffer: runState.interject,
      signal: new AbortController().signal,
    },
  };
}

void test('agent_wait declares replay-safe restart recovery', () => {
  assert.equal(agentWaitTool.recoveryStrategy, 'replay_safe');
});

void test('agent_wait snapshot projects a durably queued handle before a runtime child exists', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-wait-'));
  const ownerThreadId = testThreadId(110);
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
    now: () => new Date('2026-07-23T04:00:00.000Z'),
  });
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: store,
  });

  try {
    const [queued] = store.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-queued-wait',
        task: 'wait in durable queue',
        subagentType: 'explorer',
        capabilities: [],
        parentRunId: testRunId('queued-wait-parent'),
        ownerThreadId,
        stateRoot,
        workingDirectory: stateRoot,
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(queued);
    const { executionContext } = createWaitContext({
      daemonContext,
      threadId: ownerThreadId,
      runId: testRunId('queued-wait-observer'),
    });

    const result = await agentWaitTool.execute(
      { child_run_ids: [queued.childRunId] },
      executionContext,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output), {
      ok: true,
      completed: [],
      pending: [],
      blocked: [],
      launches: [
        {
          childRunId: queued.childRunId,
          childThreadId: queued.childThreadId,
          launchState: 'queued',
          priorityClass: 'normal',
          enqueueOrder: queued.enqueueOrder,
          createdAt: queued.createdAt,
          updatedAt: queued.updatedAt,
          runtime: queued.runtime,
        },
      ],
    });

    const foreignContext = createWaitContext({
      daemonContext,
      threadId: testThreadId(111),
      runId: testRunId('queued-wait-foreign'),
    }).executionContext;
    const foreignResult = await agentWaitTool.execute(
      { child_run_ids: [queued.childRunId] },
      foreignContext,
    );
    assert.equal(foreignResult.ok, false);
    assert.equal(foreignResult.errorCode, 'invalid_args');
    assert.match(foreignResult.error ?? '', /does not belong/u);
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_wait recovers an exact durable terminal outcome after the child registry is lost', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-wait-'));
  const ownerThreadId = testThreadId(112);
  const childRunId = testRunId('durable-terminal-child');
  const parentRunId = testRunId('durable-terminal-parent');
  const childThreadId = testThreadId(113);
  const deliveryId = 'delivery-agent-wait-recovery';
  const resultReportSummary = '원문을 보존한 간결한 결과 보고';
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const recorded = store.recordSubagentTerminalDelivery({
    ownerThreadId,
    result: {
      deliveryId,
      parentRunId,
      childRunId,
      childThreadId,
      subagentType: 'worker',
      terminalState: 'completed',
      result: 'exact recovered child result',
      resultReportSummary,
      completedAt: '2026-07-23T04:30:00.000Z',
    },
  });
  const resultReport = {
    summary: resultReportSummary,
    sourceResultRef: recorded.outcome.resultRef,
    sourceResultDigest: recorded.outcome.resultDigest,
  };
  const daemonContext = createDaemonContext({
    subagentTerminalDeliveries: store,
  });

  try {
    const { executionContext } = createWaitContext({
      daemonContext,
      threadId: ownerThreadId,
      runId: testRunId('durable-terminal-observer'),
    });

    const snapshot = await agentWaitTool.execute(
      { child_run_ids: [childRunId] },
      executionContext,
    );
    assert.equal(snapshot.ok, true);
    assert.deepEqual(JSON.parse(snapshot.output), {
      ok: true,
      completed: [
        {
          deliveryId,
          childRunId,
          terminalState: 'completed',
          ok: true,
          result: 'exact recovered child result',
          parentRunId,
          childThreadId,
          subagentType: 'worker',
          completedAt: '2026-07-23T04:30:00.000Z',
          resultRef: recorded.outcome.resultRef,
          resultDigest: sha256Digest('exact recovered child result'),
          resultReport,
        },
      ],
      pending: [],
      blocked: [],
    });

    const joined = await agentWaitTool.execute(
      { child_run_ids: [childRunId], wait_mode: 'all' },
      executionContext,
    );
    assert.equal(joined.ok, true);
    assert.deepEqual(JSON.parse(joined.output).completed, [
      {
        deliveryId,
        childRunId,
        terminalState: 'completed',
        ok: true,
        result: 'exact recovered child result',
        parentRunId,
        childThreadId,
        subagentType: 'worker',
        completedAt: '2026-07-23T04:30:00.000Z',
        resultRef: recorded.outcome.resultRef,
        resultDigest: sha256Digest('exact recovered child result'),
        resultReport,
      },
    ]);
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_wait recovers a child retired while a blocking join is active', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-wait-'));
  const ownerThreadId = testThreadId(117);
  const childRunId = testRunId('durable-terminal-race-child');
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentTerminalDeliveries: store,
  });
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(118),
    parentRunId: testRunId('durable-terminal-race-parent'),
    ownerThreadId,
    subagentType: 'explorer',
  });

  try {
    const { executionContext } = createWaitContext({
      daemonContext,
      threadId: ownerThreadId,
      runId: testRunId('durable-terminal-race-observer'),
    });
    const joined = agentWaitTool.execute(
      {
        child_run_ids: [childRunId],
        wait_mode: 'all',
        result_mode: 'refs',
      },
      executionContext,
    );
    await delay(0);

    daemonContext.childRuns.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: 'result persisted while agent_wait is blocked',
    });
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result: {
        deliveryId: 'delivery-agent-wait-terminal-race',
        parentRunId: testRunId('durable-terminal-race-parent'),
        childRunId,
        childThreadId: testThreadId(118),
        subagentType: 'explorer',
        terminalState: 'completed',
        result: 'result persisted while agent_wait is blocked',
        completedAt: '2026-07-23T14:00:00.000Z',
      },
    });
    assert.equal(
      daemonContext.childRuns.claimTerminalChildRuns({
        ownerThreadId,
        childRunIds: [childRunId],
      }),
      1,
    );

    const result = await joined;
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output).completed, [
      {
        deliveryId: 'delivery-agent-wait-terminal-race',
        childRunId,
        terminalState: 'completed',
        ok: true,
        parentRunId: testRunId('durable-terminal-race-parent'),
        childThreadId: testThreadId(118),
        subagentType: 'explorer',
        completedAt: '2026-07-23T14:00:00.000Z',
        resultRef: recorded.outcome.resultRef,
        resultDigest: sha256Digest(
          'result persisted while agent_wait is blocked',
        ),
      },
    ]);
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_wait returns a durable mixed-outcome result-ref bundle after reopen', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-wait-'));
  const ownerThreadId = testThreadId(114);
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const completedChildRunId = testRunId('durable-ref-completed');
  const failedChildRunId = testRunId('durable-ref-failed');
  const completed = store.recordSubagentTerminalDelivery({
    ownerThreadId,
    result: {
      deliveryId: 'delivery-durable-ref-completed',
      parentRunId: testRunId('durable-ref-parent'),
      childRunId: completedChildRunId,
      childThreadId: testThreadId(115),
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      terminalState: 'completed',
      result: 'large completed body that should not enter fan-in',
      completedAt: '2026-07-23T13:00:00.000Z',
      elapsedMs: 1_250,
      usage: {
        inputTokens: 1_000,
        outputTokens: 250,
        cachedInputTokens: 400,
      },
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    },
  }).outcome;
  const failed = store.recordSubagentTerminalDelivery({
    ownerThreadId,
    result: {
      deliveryId: 'delivery-durable-ref-failed',
      parentRunId: testRunId('durable-ref-parent'),
      childRunId: failedChildRunId,
      childThreadId: testThreadId(116),
      subagentType: 'worker',
      capabilities: [],
      toolSurface: 'worker',
      terminalState: 'failed',
      reason: 'provider_error',
      result: 'large failed body that should not enter fan-in',
      completedAt: '2026-07-23T13:00:01.000Z',
    },
  }).outcome;
  store.close();
  store = await createDaemonRuntimeStateStore({ homeStateRoot: stateRoot });
  const daemonContext = createDaemonContext({
    subagentTerminalDeliveries: store,
  });

  try {
    const { executionContext } = createWaitContext({
      daemonContext,
      threadId: ownerThreadId,
      runId: testRunId('durable-ref-observer'),
    });
    const result = await agentWaitTool.execute(
      {
        child_run_ids: [completedChildRunId, failedChildRunId],
      },
      executionContext,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output), {
      ok: true,
      completed: [
        {
          deliveryId: 'delivery-durable-ref-completed',
          childRunId: completedChildRunId,
          terminalState: 'completed',
          ok: true,
          parentRunId: testRunId('durable-ref-parent'),
          childThreadId: testThreadId(115),
          subagentType: 'explorer',
          capabilities: ['ptc'],
          toolSurface: 'explorer_ptc',
          completedAt: '2026-07-23T13:00:00.000Z',
          elapsedMs: 1_250,
          usage: {
            inputTokens: 1_000,
            outputTokens: 250,
            cachedInputTokens: 400,
          },
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
          resultRef: completed.resultRef,
          resultDigest: sha256Digest(
            'large completed body that should not enter fan-in',
          ),
        },
        {
          deliveryId: 'delivery-durable-ref-failed',
          childRunId: failedChildRunId,
          terminalState: 'failed',
          ok: false,
          reason: 'provider_error',
          parentRunId: testRunId('durable-ref-parent'),
          childThreadId: testThreadId(116),
          subagentType: 'worker',
          capabilities: [],
          toolSurface: 'worker',
          completedAt: '2026-07-23T13:00:01.000Z',
          resultRef: failed.resultRef,
          resultDigest: sha256Digest(
            'large failed body that should not enter fan-in',
          ),
        },
      ],
      pending: [],
      blocked: [],
    });
    assert.doesNotMatch(result.output, /large .* body/u);
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_wait returns completed children immediately', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-1');
  const childThreadId = testThreadId(2);
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId,
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'child complete',
  });
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    executionContext.threadId,
    {
      deliveryId: 'delivery-child-1',
      parentRunId: testRunId('parent-run'),
      childRunId,
      childThreadId,
      subagentType: 'explorer',
      terminalState: 'completed',
      result: 'child complete',
      completedAt: '2026-07-28T10:00:00.000Z',
    },
  );

  const result = await agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
    },
    executionContext,
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{ childRunId: string; terminalState: string }>;
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.completed, [
    {
      childRunId,
      terminalState: 'completed',
      ok: true,
      result: 'child complete',
    },
  ]);
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, []);
  assert.equal(daemonContext.childRuns.getChildRun(childRunId), undefined);
  assert.deepEqual(
    daemonContext.backgroundNotifications.readThreadBackgroundResults(
      executionContext.threadId,
    ),
    [],
  );
});

void test('agent_wait defaults to an immediate snapshot while a child is still running', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-snapshot-running');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(102),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });

  const result = await agentWaitTool.execute(
    { child_run_ids: [childRunId] },
    executionContext,
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: unknown[];
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.completed, []);
  assert.deepEqual(payload.pending, [childRunId]);
  assert.deepEqual(payload.blocked, []);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'running',
  );
});

void test('agent_wait default snapshot reports approval-blocked children without blocking the parent', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-snapshot-blocked');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(103),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'worker',
  });
  daemonContext.childRuns.markChildApprovalPending(childRunId);

  const result = await agentWaitTool.execute(
    { child_run_ids: [childRunId] },
    executionContext,
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: unknown[];
    pending: string[];
    blocked: Array<{ childRunId: string; blockedReason: string }>;
  };
  assert.deepEqual(payload.completed, []);
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, [
    {
      childRunId,
      blockedReason: AGENT_WAIT_APPROVAL_BLOCKED_REASON,
    },
  ]);
});

void test('agent_wait wait_mode any returns once one child becomes terminal', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const firstChildRunId = testRunId('child-1');
  const secondChildRunId = testRunId('child-2');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId: firstChildRunId,
    childThreadId: testThreadId(3),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId: secondChildRunId,
    childThreadId: testThreadId(4),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'worker',
  });

  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [firstChildRunId, secondChildRunId],
      wait_mode: 'any',
    },
    executionContext,
  );

  await delay(0);
  daemonContext.childRuns.markChildApprovalPending(secondChildRunId);
  daemonContext.childRuns.markChildTerminal({
    childRunId: firstChildRunId,
    terminalState: 'failed',
    result: 'child failed',
    reason: 'child_error',
  });

  const result = await waiting;
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{
      childRunId: string;
      terminalState: string;
      reason?: string;
    }>;
    pending: string[];
    blocked: Array<{ childRunId: string; blockedReason: string }>;
  };
  assert.deepEqual(payload.completed, [
    {
      childRunId: firstChildRunId,
      terminalState: 'failed',
      ok: false,
      reason: 'child_error',
      result: 'child failed',
    },
  ]);
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, [
    {
      childRunId: secondChildRunId,
      blockedReason: AGENT_WAIT_APPROVAL_BLOCKED_REASON,
    },
  ]);
  assert.equal(daemonContext.childRuns.getChildRun(firstChildRunId), undefined);
  assert.equal(
    daemonContext.childRuns.getChildRun(secondChildRunId)?.status,
    'approval_pending',
  );
});

void test('agent_wait wait_mode any stays active while every listed child awaits approval', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-any-blocked');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(8),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'worker',
  });
  daemonContext.childRuns.markChildApprovalPending(childRunId);

  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
      wait_mode: 'any',
    },
    executionContext,
  );

  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await delay(0);
  assert.equal(settled, false);

  daemonContext.childRuns.markChildRunning(childRunId);
  await delay(0);
  assert.equal(settled, false);

  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'child resumed after approval',
  });

  const result = await waiting;
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{
      childRunId: string;
      terminalState: string;
      ok: boolean;
      result: string;
    }>;
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.completed, [
    {
      childRunId,
      terminalState: 'completed',
      ok: true,
      result: 'child resumed after approval',
    },
  ]);
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, []);
  assert.equal(daemonContext.childRuns.getChildRun(childRunId), undefined);
});

void test('agent_wait wait_mode all stays active until an approval-blocked child becomes terminal', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-blocked');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(7),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'worker',
  });
  daemonContext.childRuns.markChildApprovalPending(childRunId);

  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
      wait_mode: 'all',
    },
    executionContext,
  );

  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await delay(0);
  assert.equal(settled, false);

  daemonContext.childRuns.markChildRunning(childRunId);
  await delay(0);
  assert.equal(settled, false);

  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'child resumed after approval',
  });

  const result = await waiting;
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{
      childRunId: string;
      terminalState: string;
      ok: boolean;
      result: string;
    }>;
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.completed, [
    {
      childRunId,
      terminalState: 'completed',
      ok: true,
      result: 'child resumed after approval',
    },
  ]);
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, []);
  assert.equal(daemonContext.childRuns.getChildRun(childRunId), undefined);
});

void test('agent_wait wait_mode all blocks until every child is terminal', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const firstChildRunId = testRunId('child-1');
  const secondChildRunId = testRunId('child-2');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId: firstChildRunId,
    childThreadId: testThreadId(5),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId: secondChildRunId,
    childThreadId: testThreadId(6),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'worker',
  });

  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [firstChildRunId, secondChildRunId],
      wait_mode: 'all',
    },
    executionContext,
  );

  await delay(0);
  daemonContext.childRuns.markChildTerminal({
    childRunId: firstChildRunId,
    terminalState: 'completed',
    result: 'child one complete',
  });

  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await delay(10);
  assert.equal(settled, false);

  daemonContext.childRuns.markChildTerminal({
    childRunId: secondChildRunId,
    terminalState: 'cancelled',
    result: 'child two cancelled',
    reason: 'user_interrupt',
  });

  const result = await waiting;
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{
      childRunId: string;
      terminalState: string;
      reason?: string;
    }>;
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, []);
  assert.deepEqual(payload.completed, [
    {
      childRunId: firstChildRunId,
      terminalState: 'completed',
      ok: true,
      result: 'child one complete',
    },
    {
      childRunId: secondChildRunId,
      terminalState: 'cancelled',
      ok: false,
      reason: 'user_interrupt',
      result: 'child two cancelled',
    },
  ]);
});

void test('agent_wait releases a blocking join when the user requests immediate interject delivery', async () => {
  const { daemonContext, executionContext, runState } = createWaitContext();
  const childRunId = testRunId('child-interject-flush');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(87),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });

  const waiting = agentWaitTool.execute(
    { child_run_ids: [childRunId], wait_mode: 'all' },
    executionContext,
  );
  await delay(0);
  pushPendingInterject(runState.interject, '지금 방향을 바꿔 주세요.');
  assert.equal(requestInterjectFlush(runState.interject), true);

  const fallbackTerminal = setTimeout(() => {
    daemonContext.childRuns.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: 'late completion',
    });
  }, 30);
  const result = await waiting;
  clearTimeout(fallbackTerminal);

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: unknown[];
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.completed, []);
  assert.deepEqual(payload.pending, [childRunId]);
  assert.deepEqual(payload.blocked, []);
});

void test('waitForAgentChildren exposes the same wait owner without a tool wrapper', async () => {
  const registry = createChildRunRegistry();
  const ownerThreadId = testThreadId(1);
  const childRunId = testRunId('child-workflow-wait');
  registry.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(8),
    parentRunId: testRunId('parent-run'),
    ownerThreadId,
    subagentType: 'explorer',
  });

  const waiting = waitForAgentChildren({
    registry,
    ownerThreadId,
    childRunIds: [childRunId],
    waitMode: 'all',
    blockedBehavior: 'wait',
  });
  registry.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'workflow child complete',
  });

  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok ? outcome.result.completed : [], [
    {
      childRunId,
      terminalState: 'completed',
      ok: true,
      result: 'workflow child complete',
    },
  ]);
});

void test('agent_wait preserves timeout terminal reasons', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-timeout');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(7),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'cancelled',
    result: 'child timed out',
    reason: 'timeout',
  });

  const result = await agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
    },
    executionContext,
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{ reason?: string }>;
  };
  assert.equal(payload.completed[0]?.reason, 'timeout');
});

void test('agent_wait can collect a retained child from a newer parent run in the same owner thread', async () => {
  const ownerThreadId = testThreadId(1);
  const childRunId = testRunId('child-reconnect');
  const { daemonContext, executionContext } = createWaitContext({
    runId: 'new-parent-run',
    threadId: ownerThreadId,
  });
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(2),
    parentRunId: testRunId('old-parent-run'),
    ownerThreadId,
    subagentType: 'worker',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'child complete after reconnect',
  });

  const result = await agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
    },
    executionContext,
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{ childRunId: string; result: string }>;
  };
  assert.deepEqual(payload.completed, [
    {
      childRunId,
      terminalState: 'completed',
      ok: true,
      result: 'child complete after reconnect',
    },
  ]);
});

void test('agent_wait can resume waiting on a running child from a newer parent run in the same owner thread', async () => {
  const ownerThreadId = testThreadId(1);
  const childRunId = testRunId('child-running-reconnect');
  const { daemonContext, executionContext } = createWaitContext({
    runId: 'new-parent-run',
    threadId: ownerThreadId,
  });
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(2),
    parentRunId: testRunId('old-parent-run'),
    ownerThreadId,
    subagentType: 'worker',
  });

  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
      wait_mode: 'all',
    },
    executionContext,
  );

  await delay(0);
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'child completed after resumed wait',
  });

  const result = await waiting;
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{ childRunId: string; result: string }>;
    pending: string[];
    blocked: unknown[];
  };
  assert.deepEqual(payload.completed, [
    {
      childRunId,
      terminalState: 'completed',
      ok: true,
      result: 'child completed after resumed wait',
    },
  ]);
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(payload.blocked, []);
});

void test('agent_wait rejects unknown child handles', async () => {
  const { executionContext } = createWaitContext();

  const result = await agentWaitTool.execute(
    {
      child_run_ids: ['missing-child'],
    },
    executionContext,
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unknown child run/);
});

void test('agent_wait rejects child handles owned by another thread as an outer tool failure', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('foreign-child');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(98),
    parentRunId: testRunId('foreign-parent'),
    ownerThreadId: testThreadId(99),
    subagentType: 'worker',
  });

  const result = await agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
    },
    executionContext,
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /does not belong to current owner thread/);
  assert.equal(result.output, '');
});

void test('agent_wait reports caller aborts as aborted failures', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-wait-abort');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(100),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });

  const abortController = new AbortController();
  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
      wait_mode: 'all',
    },
    {
      ...executionContext,
      signal: abortController.signal,
    },
  );

  await delay(0);
  abortController.abort();

  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'aborted');
  assert.match(result.error ?? '', /agent_wait aborted/);
});

void test('agent_wait reports internal revision wait failures without reclassifying them as aborts', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-wait-internal-failure');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(101),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });

  const originalWaitForRevisionChange =
    daemonContext.childRuns.waitForRevisionChange;
  daemonContext.childRuns.waitForRevisionChange = async () => {
    throw new Error('revision tracker failed');
  };

  try {
    const result = await agentWaitTool.execute(
      {
        child_run_ids: [childRunId],
        wait_mode: 'all',
      },
      executionContext,
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'execution_failed');
    assert.match(
      result.error ?? '',
      /agent_wait failed: revision tracker failed/,
    );
  } finally {
    daemonContext.childRuns.waitForRevisionChange =
      originalWaitForRevisionChange;
  }
});

void test('agent_wait(all) over a broad fan-out returns every result', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const ids = Array.from({ length: 20 }, (_, index) =>
    testRunId(`fan-${index}`),
  );
  ids.forEach((childRunId, index) => {
    daemonContext.childRuns.registerChildRun({
      ...TEST_CHILD_MODEL_REGISTRATION,
      childRunId,
      childThreadId: testThreadId(10 + index),
      parentRunId: testRunId('parent-run'),
      ownerThreadId: executionContext.threadId,
      subagentType: 'worker',
    });
  });

  const waiting = agentWaitTool.execute(
    { child_run_ids: ids, wait_mode: 'all' },
    executionContext,
  );
  await delay(5);
  for (const childRunId of ids) {
    daemonContext.childRuns.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: `${childRunId}-done`,
    });
    await delay(1);
  }

  const result = await waiting;
  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    completed: Array<{ childRunId: string }>;
    pending: string[];
  };
  assert.equal(payload.completed.length, ids.length);
  assert.deepEqual(
    payload.completed.map((entry) => entry.childRunId).sort(),
    [...ids].sort(),
  );
  assert.deepEqual(payload.pending, []);
  assert.deepEqual(
    ids.map((childRunId) => daemonContext.childRuns.getChildRun(childRunId)),
    ids.map(() => undefined),
  );
});
