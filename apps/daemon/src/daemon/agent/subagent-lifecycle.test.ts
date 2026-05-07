import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createDaemonContext } from '../context.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEvent } from '../runtime-contracts.js';
import { createRunState } from './runtime/run-state.js';
import { beginBackgroundChildLifecycle } from './subagent-lifecycle.js';

void test('beginBackgroundChildLifecycle registers child run and terminal publication cleans parent handles', () => {
  const runtimeServices = createDaemonContext();
  const projectId = testProjectId('subagent-lifecycle');
  const ownerThreadId = testThreadId(61);
  const childThreadId = testThreadId(62);
  const parentRunId = testRunId('lifecycle-parent');
  const childRunId = testRunId('lifecycle-child');
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunWorkspaceContext({
      threadId: ownerThreadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  const childRunState = createRunState({
    runId: childRunId,
    runContext: makeRunWorkspaceContext({
      threadId: childThreadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
    parentRunId,
  });
  let finishCount = 0;
  let releaseCount = 0;
  const emittedEvents: AgentEvent[] = [];

  const lifecycle = beginBackgroundChildLifecycle({
    subagentType: 'explorer',
    parentRunId,
    ownerThreadId,
    startedChildRun: {
      runId: childRunId,
      threadId: childThreadId,
      runState: childRunState,
      finish() {
        finishCount += 1;
      },
    },
    parentRunState,
    runtimeServices,
    launchReservation: {
      release() {
        releaseCount += 1;
      },
    },
    emitAgentEvent(event) {
      emittedEvents.push(event);
    },
    timeoutMs: 60_000,
  });

  assert.equal(releaseCount, 1);
  assert.equal(parentRunState.childRunIds.has(childRunId), true);
  assert.equal(parentRunState.backgroundChildRunIds.has(childRunId), true);
  assert.equal(
    runtimeServices.childRuns.getChildRun(childRunId)?.status,
    'running',
  );
  assert.deepEqual(emittedEvents, [
    {
      type: 'subagent_spawned',
      payload: {
        parentRunId,
        childRunId,
        childThreadId,
        subagentType: 'explorer',
      },
    },
  ]);

  lifecycle.publishTerminalOutcome({
    terminalState: 'completed',
    terminalReason: null,
    terminalResult: 'child done',
  });

  assert.equal(finishCount, 1);
  assert.equal(parentRunState.childRunIds.has(childRunId), false);
  assert.equal(parentRunState.backgroundChildRunIds.has(childRunId), false);
  const terminalSnapshot = runtimeServices.childRuns.getChildRun(childRunId);
  assert.equal(terminalSnapshot?.status, 'completed');
  assert.equal(terminalSnapshot?.result, 'child done');
  assert.equal(terminalSnapshot?.reason, null);
  const [backgroundResult] =
    runtimeServices.backgroundNotifications.consumeThreadBackgroundResults(
      ownerThreadId,
    );
  assert.equal(backgroundResult?.parentRunId, parentRunId);
  assert.equal(backgroundResult?.childRunId, childRunId);
  assert.equal(backgroundResult?.terminalState, 'completed');
  assert.equal(backgroundResult?.ok, true);
  assert.equal(backgroundResult?.result, 'child done');
});

void test('beginBackgroundChildLifecycle forwards timeout aborts to the child run', async () => {
  const runtimeServices = createDaemonContext();
  const projectId = testProjectId('subagent-lifecycle-timeout');
  const ownerThreadId = testThreadId(63);
  const childThreadId = testThreadId(64);
  const parentRunId = testRunId('lifecycle-timeout-parent');
  const childRunId = testRunId('lifecycle-timeout-child');
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunWorkspaceContext({
      threadId: ownerThreadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  const childRunState = createRunState({
    runId: childRunId,
    runContext: makeRunWorkspaceContext({
      threadId: childThreadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
    parentRunId,
  });

  const lifecycle = beginBackgroundChildLifecycle({
    subagentType: 'worker',
    parentRunId,
    ownerThreadId,
    startedChildRun: {
      runId: childRunId,
      threadId: childThreadId,
      runState: childRunState,
      finish() {},
    },
    parentRunState,
    runtimeServices,
    launchReservation: undefined,
    emitAgentEvent: undefined,
    timeoutMs: 5,
  });

  await delay(20);

  assert.equal(lifecycle.isTimedOut(), true);
  assert.equal(childRunState.abortController.signal.aborted, true);
  assert.equal(childRunState.abortController.signal.reason, 'child timeout');

  lifecycle.publishTerminalOutcome({
    terminalState: 'cancelled',
    terminalReason: 'timeout',
    terminalResult: 'sub-agent cancelled',
  });
});

void test('beginBackgroundChildLifecycle has no timeout unless one is explicitly configured', async () => {
  const runtimeServices = createDaemonContext();
  const projectId = testProjectId('subagent-lifecycle-no-timeout');
  const ownerThreadId = testThreadId(65);
  const childThreadId = testThreadId(66);
  const parentRunId = testRunId('lifecycle-no-timeout-parent');
  const childRunId = testRunId('lifecycle-no-timeout-child');
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunWorkspaceContext({
      threadId: ownerThreadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
  });
  const childRunState = createRunState({
    runId: childRunId,
    runContext: makeRunWorkspaceContext({
      threadId: childThreadId,
      projectId,
      workspaceRoot: '/tmp/workspace',
    }),
    parentRunId,
  });

  const lifecycle = beginBackgroundChildLifecycle({
    subagentType: 'worker',
    parentRunId,
    ownerThreadId,
    startedChildRun: {
      runId: childRunId,
      threadId: childThreadId,
      runState: childRunState,
      finish() {},
    },
    parentRunState,
    runtimeServices,
    launchReservation: undefined,
    emitAgentEvent: undefined,
  });

  await delay(20);

  assert.equal(lifecycle.isTimedOut(), false);
  assert.equal(childRunState.abortController.signal.aborted, false);

  lifecycle.publishTerminalOutcome({
    terminalState: 'completed',
    terminalReason: null,
    terminalResult: 'sub-agent completed',
  });
});
