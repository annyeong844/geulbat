import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptRunSessionMessage,
  handleRunSessionMessage,
  shouldRefreshTreeAfterToolResult,
} from './run-session-message-effects.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import {
  CHILD_RUN_ID,
  RUN_ID,
  STALE_RUN_ID,
  THREAD_ID,
  createPersistedThreadDetail,
} from '../test-support/run-session-fixtures.js';

void test('handleRunSessionMessage acknowledges the run and refreshes threads', async () => {
  const actions: RunSessionStateAction[] = [];
  const startedRuns: Array<{ threadId: string; runId: string }> = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ack',
        payload: { runId: RUN_ID, threadId: THREAD_ID },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: (threadId, runId) => {
      startedRuns.push({ threadId, runId });
    },
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, []);
  assert.deepEqual(startedRuns, [{ threadId: THREAD_ID, runId: RUN_ID }]);
});

void test('handleRunSessionMessage applies a daemon-owned planning workflow snapshot', async () => {
  const snapshots: unknown[] = [];
  const snapshot = {
    state: 'collecting' as const,
    workflowId: 'workflow-live',
    threadId: THREAD_ID,
    intensity: 'visual' as const,
    depth: 'standard' as const,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  };

  await handleRunSessionMessage({
    message: {
      type: 'plan.workflow',
      threadId: THREAD_ID,
      snapshot,
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    handlePlanningWorkflow: (threadId, received) => {
      snapshots.push({ threadId, snapshot: received });
    },
  });

  assert.deepEqual(snapshots, [{ threadId: THREAD_ID, snapshot }]);
});

void test('handleRunSessionMessage applies only the daemon-owned aggregate Goal snapshot', async () => {
  const snapshots: unknown[] = [];
  const snapshot = {
    goalId: 'goal-live',
    threadId: THREAD_ID,
    objective: 'Ship Goal mode',
    state: 'verifying' as const,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:01:00.000Z',
  };

  await handleRunSessionMessage({
    message: {
      type: 'goal.state',
      threadId: THREAD_ID,
      snapshot,
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    handleGoal: (threadId, received) => {
      snapshots.push({ threadId, snapshot: received });
    },
  });

  assert.deepEqual(snapshots, [{ threadId: THREAD_ID, snapshot }]);
});

void test('adaptRunSessionMessage keeps transport failure structured before shell formatting', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.error',
      code: 'internal',
      message: 'socket broke',
      status: 500,
    }),
    {
      kind: 'run_transport_error',
      code: 'internal',
      message: 'socket broke',
    },
  );
});

void test('adaptRunSessionMessage maps cursor-free tool output into a live stream effect', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.tool.output.delta',
      runId: RUN_ID,
      threadId: THREAD_ID,
      payload: {
        callId: 'call-exec',
        tool: 'exec_command',
        stream: 'stdout',
        text: 'working',
      },
    }),
    {
      kind: 'tool_output_streamed',
      threadId: THREAD_ID,
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stdout',
      text: 'working',
    },
  );
});

void test('adaptRunSessionMessage preserves a failed done event as terminal run evidence', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'done',
        payload: {
          answer: 'partial answer',
          ok: false,
        },
      },
    }),
    {
      kind: 'run_terminal',
      runId: RUN_ID,
      threadId: THREAD_ID,
      ok: false,
    },
  );
});

void test('handleRunSessionMessage dispatches failed done evidence to run state', async () => {
  const actions: RunSessionStateAction[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'done',
        payload: {
          answer: 'partial answer',
          ok: false,
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, [
    {
      type: 'run_terminal',
      runId: RUN_ID,
      threadId: THREAD_ID,
      ok: false,
    },
  ]);
});

void test('adaptRunSessionMessage maps usage_updated events to usage effects', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'usage_updated',
        payload: {
          inputTokens: 9800,
          outputTokens: 252,
          cachedInputTokens: 4000,
        },
      },
    }),
    {
      kind: 'usage_updated',
      runId: RUN_ID,
      threadId: THREAD_ID,
      usage: { inputTokens: 9800, outputTokens: 252, cachedInputTokens: 4000 },
    },
  );
});

void test('adaptRunSessionMessage preserves provider auth wait for replayed UI projection', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: '2026-07-23T11:00:00.000Z',
        type: 'provider_status',
        payload: {
          phase: 'auth_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
        },
      },
    }),
    {
      kind: 'provider_runtime_updated',
      runId: RUN_ID,
      threadId: THREAD_ID,
      providerRuntime: {
        phase: 'auth_waiting',
        observedAt: '2026-07-23T11:00:00.000Z',
      },
    },
  );
});

void test('handleRunSessionMessage ignores usage from an earlier same-thread run', async () => {
  let state = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'run_started',
    threadId: THREAD_ID,
    runId: RUN_ID,
  });

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: STALE_RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'usage_updated',
        payload: {
          inputTokens: 9800,
          outputTokens: 252,
          cachedInputTokens: 4000,
        },
      },
    },
    dispatch: (action) => {
      state = reduceRunSessionState(state, action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.equal(state.activeRunView.usageTotals, null);
});

void test('adaptRunSessionMessage maps context usage snapshots without estimating them', () => {
  const contextUsage = {
    state: 'measured' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
  };

  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: '2026-07-17T00:00:00.000Z',
        type: 'context_usage_updated',
        payload: contextUsage,
      },
    }),
    {
      kind: 'context_usage_updated',
      threadId: THREAD_ID,
      contextUsage,
    },
  );
});

void test('adaptRunSessionMessage promotes applied interjects to steer_applied effects', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'interject_applied',
        payload: {
          runId: RUN_ID,
          count: 1,
          receivedSeqs: [1],
        },
      },
    }),
    {
      kind: 'steer_applied',
      runId: RUN_ID,
      threadId: THREAD_ID,
      receivedSeqs: [1],
    },
  );
});

void test('handleRunSessionMessage ignores applied interjects from an earlier same-thread run', async () => {
  let state = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'run_started',
    threadId: THREAD_ID,
    runId: RUN_ID,
  });
  state = reduceRunSessionState(state, {
    type: 'steer_queued',
    runId: RUN_ID,
    threadId: THREAD_ID,
    steer: { receivedSeq: 1, text: 'current-run steer' },
  });

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: STALE_RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'interject_applied',
        payload: {
          runId: STALE_RUN_ID,
          count: 1,
          receivedSeqs: [1],
        },
      },
    },
    dispatch: (action) => {
      state = reduceRunSessionState(state, action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(state.activeRunView.pendingSteers, [
    { receivedSeq: 1, text: 'current-run steer' },
  ]);
  assert.deepEqual(state.activeRunView.transcriptEntries, []);
});

void test('adaptRunSessionMessage maps semantic subagent lifecycle events to transcript entries', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: CHILD_RUN_ID,
        threadId: THREAD_ID,
        seq: 7,
        ts: new Date().toISOString(),
        type: 'subagent_terminal',
        payload: {
          deliveryId: 'delivery-1',
          parentRunId: RUN_ID,
          childRunId: CHILD_RUN_ID,
          subagentType: 'worker',
          terminalState: 'failed',
          ok: false,
          reason: 'child_error',
          result: 'sub-agent failed',
        },
      },
    }),
    {
      kind: 'subagent_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-1',
        parentRunId: RUN_ID,
        childRunId: CHILD_RUN_ID,
        subagentType: 'worker',
        state: 'failed',
        reason: 'child_error',
        result: 'sub-agent failed',
      },
    },
  );
});

void test('adaptRunSessionMessage keeps queued and rejected PTC admission distinct in live tool rows', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 8,
        ts: new Date().toISOString(),
        type: 'tool_result',
        payload: {
          callId: 'call-ptc-queued',
          step: 1,
          tool: 'exec',
          ok: true,
          computerFilesMayHaveChanged: false,
          displayText: JSON.stringify({
            kind: 'ptc_execute_code_cell_queued',
            status: 'queued',
            cellId: 'ptc_cell_queued',
          }),
          raw: {
            kind: 'ptc_execute_code_cell_queued',
            status: 'queued',
            cellId: 'ptc_cell_queued',
          },
        },
      },
    }),
    {
      kind: 'transcript_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'tool_activity',
        tool: 'exec',
        state: 'completed',
        callId: 'call-ptc-queued',
        ptcStatus: 'queued',
      },
      computerFilesMayHaveChanged: false,
    },
  );

  const rejected = adaptRunSessionMessage({
    type: 'run.event',
    event: {
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 9,
      ts: new Date().toISOString(),
      type: 'tool_result',
      payload: {
        callId: 'call-ptc-rejected',
        step: 1,
        tool: 'exec',
        ok: false,
        errorCode: 'execution_failed',
        error: 'resource budget is insufficient',
        computerFilesMayHaveChanged: false,
        displayText: 'resource budget is insufficient',
        raw: {
          kind: 'ptc_execute_code_error',
          reasonCode: 'resource_budget_insufficient',
          message: 'resource budget is insufficient',
        },
      },
    },
  });
  assert.equal(rejected?.kind, 'transcript_activity_added');
  if (rejected?.kind === 'transcript_activity_added') {
    assert.deepEqual(rejected.entry, {
      kind: 'tool_activity',
      tool: 'exec',
      state: 'failed',
      callId: 'call-ptc-rejected',
      ptcStatus: 'resource_budget_insufficient',
    });
  }
});

void test('handleRunSessionMessage marks tree refresh when daemon reports computer file changes', async () => {
  const actions: RunSessionStateAction[] = [];
  let requestedRefreshCount = 0;

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'tool_result',
        payload: {
          callId: 'call-1',
          step: 1,
          tool: 'write_file',
          ok: false,
          errorCode: 'internal',
          error: 'write failed',
          computerFilesMayHaveChanged: true,
          displayText: 'ok',
          raw: {},
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {
      requestedRefreshCount += 1;
    },
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.equal(requestedRefreshCount, 1);
  assert.deepEqual(actions, [
    {
      type: 'transcript_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'tool_activity',
        tool: 'write_file',
        state: 'failed',
        callId: 'call-1',
      },
    },
  ]);
});

void test('handleRunSessionMessage dispatches committed artifacts into live run state', async () => {
  const actions: RunSessionStateAction[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'artifact_committed',
        payload: {
          artifactId: 'art_1',
          version: 1,
          parentVersion: null,
          baseVersion: null,
          renderer: 'markdown',
          payload: '# title',
          digest: '요약',
          contentHash: 'hash',
          createdAt: '2026-04-10T00:00:00.000Z',
          createdByRunId: RUN_ID,
          previewValidation: { ok: true },
          title: null,
          persistenceEpoch: 0,
          sourceRef: {
            kind: 'thread-file',
            workingDirectory: 'computer-root',
            threadId: THREAD_ID,
            runId: RUN_ID,
            filePath: 'episodes/ch01.md',
            messageTimestamp: '2026-04-10T00:00:00.000Z',
          },
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, [
    {
      type: 'artifact_activated',
      threadId: THREAD_ID,
      artifact: {
        artifactId: 'art_1',
        version: 1,
        parentVersion: null,
        baseVersion: null,
        renderer: 'markdown',
        payload: '# title',
        digest: '요약',
        contentHash: 'hash',
        createdAt: '2026-04-10T00:00:00.000Z',
        createdByRunId: RUN_ID,
        previewValidation: { ok: true },
        title: null,
        persistenceEpoch: 0,
        sourceRef: {
          kind: 'thread-file',
          workingDirectory: 'computer-root',
          threadId: THREAD_ID,
          runId: RUN_ID,
          filePath: 'episodes/ch01.md',
          messageTimestamp: '2026-04-10T00:00:00.000Z',
        },
      },
    },
  ]);
});

void test('handleRunSessionMessage dispatches semantic subagent activity entries', async () => {
  const actions: RunSessionStateAction[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: CHILD_RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'subagent_spawned',
        payload: {
          parentRunId: RUN_ID,
          childRunId: CHILD_RUN_ID,
          subagentType: 'worker',
          childThreadId: THREAD_ID,
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, [
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'subagent_activity',
        parentRunId: RUN_ID,
        childRunId: CHILD_RUN_ID,
        childThreadId: THREAD_ID,
        subagentType: 'worker',
        state: 'spawned',
      },
    },
  ]);
  assert.equal(
    shouldRefreshTreeAfterToolResult({
      computerFilesMayHaveChanged: true,
    }),
    true,
  );
  assert.equal(
    shouldRefreshTreeAfterToolResult({
      computerFilesMayHaveChanged: false,
    }),
    false,
  );
});

void test('handleRunSessionMessage settles successful runs through the provided success callback', async () => {
  const settledThreadIds: string[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async (thread) => {
      settledThreadIds.push(thread.threadId);
    },
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(settledThreadIds, [THREAD_ID]);
});

void test('handleRunSessionMessage routes thread snapshot sync failures through the dedicated failure callback', async () => {
  const syncFailures: Array<{ threadId: string; message: string }> = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'thread_state_persist_failed',
        payload: {
          message:
            'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
        },
      },
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async (threadId, message) => {
      syncFailures.push({ threadId, message });
    },
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(syncFailures, [
    {
      threadId: THREAD_ID,
      message:
        'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
    },
  ]);
});

void test('handleRunSessionMessage settles errored runs through the provided error callback', async () => {
  const settledErrors: Array<{
    threadId: string;
    code: string;
    message: string;
  }> = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'error',
        payload: {
          code: 'internal',
          message: 'broken',
        },
      },
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async (threadId, code, message) => {
      settledErrors.push({ threadId, code, message });
    },
  });

  assert.deepEqual(settledErrors, [
    {
      threadId: THREAD_ID,
      code: 'internal',
      message: 'broken',
    },
  ]);
});
