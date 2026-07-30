import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256Digest } from '@geulbat/content-identity/sha256';

import { agentWaitTool } from './agent-wait.js';
import { createDaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import { testRunId } from '../../../test-support/run-id.js';
import { createWaitContext } from '../../../test-support/agent-wait-test-support.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_CHILD_MODEL_REGISTRATION,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';

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
