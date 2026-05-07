import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { agentWaitTool } from './agent-wait.js';
import { createDaemonContext } from '../../context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import type { ThreadId } from '@geulbat/protocol/ids';

function createWaitContext(args?: { runId?: string; threadId?: ThreadId }) {
  const daemonContext = createDaemonContext();
  const threadId = args?.threadId ?? testThreadId(1);
  return {
    daemonContext,
    executionContext: {
      callId: 'call-wait',
      workspaceRoot: '/tmp/workspace',
      runId: args?.runId ?? 'parent-run',
      threadId,
      agentSpawnRuntime: daemonContext,
      signal: new AbortController().signal,
    },
  };
}

void test('agent_wait returns completed children immediately', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-1');
  daemonContext.childRuns.registerChildRun({
    childRunId,
    childThreadId: testThreadId(2),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'child complete',
  });

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
});

void test('agent_wait wait_mode any returns once one child becomes terminal', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const firstChildRunId = testRunId('child-1');
  const secondChildRunId = testRunId('child-2');
  daemonContext.childRuns.registerChildRun({
    childRunId: firstChildRunId,
    childThreadId: testThreadId(3),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.registerChildRun({
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
      blockedReason: 'approval_pending',
    },
  ]);
});

void test('agent_wait wait_mode all blocks until every child is terminal', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const firstChildRunId = testRunId('child-1');
  const secondChildRunId = testRunId('child-2');
  daemonContext.childRuns.registerChildRun({
    childRunId: firstChildRunId,
    childThreadId: testThreadId(5),
    parentRunId: testRunId('parent-run'),
    ownerThreadId: executionContext.threadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.registerChildRun({
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

void test('agent_wait preserves timeout terminal reasons', async () => {
  const { daemonContext, executionContext } = createWaitContext();
  const childRunId = testRunId('child-timeout');
  daemonContext.childRuns.registerChildRun({
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
    childRunId,
    childThreadId: testThreadId(2),
    parentRunId: testRunId('old-parent-run'),
    ownerThreadId,
    subagentType: 'worker',
  });

  const waiting = agentWaitTool.execute(
    {
      child_run_ids: [childRunId],
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
