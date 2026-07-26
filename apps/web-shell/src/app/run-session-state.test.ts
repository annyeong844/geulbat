import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getActiveRunId,
  isRunSessionStarting,
  selectVisibleRunState,
} from './run-session-state-selectors.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';

import {
  OTHER_THREAD_ID_VALUE,
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';

void test('run usage updates land on the active run view and reset per run', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-1',
  });
  const usage = { inputTokens: 9800, outputTokens: 252, cachedInputTokens: 0 };
  const updated = reduceRunSessionState(running, {
    type: 'run_usage_updated',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    usage,
  });

  assert.equal(updated.activeRunView.usageTotals, usage);
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: updated,
    }).usageTotals,
    usage,
  );

  // 다른 스레드의 usage는 활성 런 뷰를 오염시키지 않는다
  const mismatched = reduceRunSessionState(updated, {
    type: 'run_usage_updated',
    runId: 'run-1',
    threadId: OTHER_THREAD_ID_VALUE,
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  });
  assert.equal(mismatched.activeRunView.usageTotals, usage);

  // 다음 런 시작 시 초기화
  const nextRun = reduceRunSessionState(mismatched, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  assert.equal(nextRun.activeRunView.usageTotals, null);
});

void test('provider admission status stays scoped to the exact run and clears when output resumes', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: 'run-1',
    },
  );
  const waiting = reduceRunSessionState(running, {
    type: 'provider_runtime_updated',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    providerRuntime: {
      phase: 'rate_limit_waiting',
      observedAt: '2026-07-23T11:00:00.000Z',
    },
  });

  assert.deepEqual(waiting.activeRunView.providerRuntime, {
    phase: 'rate_limit_waiting',
    observedAt: '2026-07-23T11:00:00.000Z',
  });
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: waiting,
    }).providerRuntime?.phase,
    'rate_limit_waiting',
  );

  const stale = reduceRunSessionState(waiting, {
    type: 'provider_runtime_updated',
    runId: 'run-stale',
    threadId: THREAD_ID_VALUE,
    providerRuntime: {
      phase: 'provider_waiting',
      observedAt: '2026-07-23T11:00:01.000Z',
    },
  });
  assert.equal(stale, waiting);

  const resumed = reduceRunSessionState(waiting, {
    type: 'assistant_text_streamed',
    threadId: THREAD_ID_VALUE,
    target: 'transcript',
    text: '다시 응답 중',
  });
  assert.equal(resumed.activeRunView.providerRuntime, null);

  const nextRun = reduceRunSessionState(waiting, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  assert.equal(nextRun.activeRunView.providerRuntime, null);
});

void test('context usage snapshots persist per thread until the next exact measurement replaces them', () => {
  const measured = {
    state: 'measured' as const,
    quality: 'exact' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
    requestBytes: 510_000,
  };
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    { type: 'run_started', threadId: THREAD_ID_VALUE, runId: RUN_ID },
  );
  const measuredState = reduceRunSessionState(running, {
    type: 'run_context_usage_updated',
    threadId: THREAD_ID_VALUE,
    contextUsage: measured,
  });
  const sameModelUnknown = reduceRunSessionState(measuredState, {
    type: 'run_context_usage_updated',
    threadId: THREAD_ID_VALUE,
    contextUsage: {
      state: 'measured',
      quality: 'unknown',
      modelId: measured.modelId,
      requestBytes: 520_000,
    },
  });
  assert.equal(sameModelUnknown, measuredState);

  const settled = reduceRunSessionState(sameModelUnknown, {
    type: 'run_settled_success',
  });
  const withOtherThread = reduceRunSessionState(settled, {
    type: 'run_context_usage_updated',
    threadId: OTHER_THREAD_ID_VALUE,
    contextUsage: {
      state: 'compacted',
      modelId: 'grok-4.5',
      inputTokens: 425_000,
      contextWindow: 500_000,
      thresholdTokens: 425_000,
    },
  });

  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: withOtherThread,
    }).contextUsage,
    measured,
  );
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: OTHER_THREAD_ID_VALUE,
      state: withOtherThread,
    }).contextUsage?.state,
    'compacted',
  );

  const modelSwitched = reduceRunSessionState(withOtherThread, {
    type: 'run_context_usage_updated',
    threadId: THREAD_ID_VALUE,
    contextUsage: {
      state: 'measured',
      quality: 'unknown',
      modelId: 'grok-4.5',
      requestBytes: 600_000,
    },
  });
  assert.deepEqual(modelSwitched.contextUsageByThread[THREAD_ID_VALUE], {
    state: 'measured',
    quality: 'unknown',
    modelId: 'grok-4.5',
    requestBytes: 600_000,
  });

  const nextRun = reduceRunSessionState(withOtherThread, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: nextRun,
    }).contextUsage,
    measured,
  );
  assert.equal(
    nextRun.contextUsageByThread[OTHER_THREAD_ID_VALUE]?.modelId,
    'grok-4.5',
  );
});

void test('run session phase transitions move from idle to starting to running', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-1',
  });

  assert.equal(initial.phase, 'idle');
  assert.equal(isRunSessionStarting(starting), true);
  assert.equal(starting.pendingStartThreadId, THREAD_ID_VALUE);
  assert.equal(running.phase, 'running');
  assert.equal(getActiveRunId(running), 'run-1');
});

void test('run session keeps concurrent thread runs isolated and settles them independently', () => {
  const initial = createInitialRunSessionState();
  const firstRunning = reduceRunSessionState(
    reduceRunSessionState(initial, {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: 'run-thread-1',
    },
  );
  const firstStreaming = reduceRunSessionState(firstRunning, {
    type: 'assistant_text_streamed',
    threadId: THREAD_ID_VALUE,
    target: 'answer',
    text: 'first answer',
  });
  const bothRunning = reduceRunSessionState(
    reduceRunSessionState(firstStreaming, {
      type: 'run_start_requested',
      threadId: OTHER_THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: OTHER_THREAD_ID_VALUE,
      runId: 'run-thread-2',
    },
  );
  const independentlyStreaming = reduceRunSessionState(bothRunning, {
    type: 'assistant_text_streamed',
    threadId: OTHER_THREAD_ID_VALUE,
    target: 'answer',
    text: 'second answer',
  });

  const firstVisible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: independentlyStreaming,
  });
  const secondVisible = selectVisibleRunState({
    selectedThreadId: OTHER_THREAD_ID_VALUE,
    state: independentlyStreaming,
  });
  assert.equal(firstVisible.activeRunId, 'run-thread-1');
  assert.equal(firstVisible.finalAnswerText, 'first answer');
  assert.equal(firstVisible.isRunning, true);
  assert.equal(secondVisible.activeRunId, 'run-thread-2');
  assert.equal(secondVisible.finalAnswerText, 'second answer');
  assert.equal(secondVisible.isRunning, true);

  const firstSettled = reduceRunSessionState(independentlyStreaming, {
    type: 'run_settled_success',
    threadId: THREAD_ID_VALUE,
    runId: 'run-thread-1',
  });
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: firstSettled,
    }).isRunning,
    false,
  );
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: OTHER_THREAD_ID_VALUE,
      state: firstSettled,
    }).activeRunId,
    'run-thread-2',
  );
});

void test('run session error transition clears pending start and records stream error', () => {
  const starting = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'run_start_requested',
    threadId: null,
  });
  const errored = reduceRunSessionState(starting, {
    type: 'run_start_failed',
    message: '[internal] failed',
  });

  assert.equal(errored.phase, 'error');
  assert.equal(errored.pendingStartThreadId, null);
  assert.equal(errored.activeRunView.runId, null);
  assert.equal(errored.activeRunView.streamError, '[internal] failed');
  assert.equal(errored.activeRunView.streamErrorCode, null);
});

void test('run session preserves the structured model error code for recovery UX', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: RUN_ID,
    },
  );
  const errored = reduceRunSessionState(running, {
    type: 'run_settled_error',
    threadId: THREAD_ID_VALUE,
    code: 'llm_context_length_exceeded',
    message: '[llm_context_length_exceeded] context limit exceeded',
  });
  const visible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: errored,
  });

  assert.equal(visible.streamErrorCode, 'llm_context_length_exceeded');
});

void test('failed done closes the exact active run while preserving streamed output', () => {
  const runningWithPartialAnswer = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'assistant_text_streamed',
      threadId: THREAD_ID_VALUE,
      target: 'answer',
      text: 'partial answer',
    },
  );

  const failed = reduceRunSessionState(runningWithPartialAnswer, {
    type: 'run_terminal',
    runId: RUN_ID,
    threadId: THREAD_ID_VALUE,
    ok: false,
  });

  assert.equal(failed.phase, 'error');
  assert.equal(getActiveRunId(failed), null);
  assert.equal(failed.activeRunView.finalAnswerText, 'partial answer');
  assert.equal(
    failed.activeRunView.streamError,
    'Run ended before completing successfully. The streamed result is still shown.',
  );
});

void test('done does not let a stale or successful terminal event bypass the canonical settle event', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: RUN_ID,
    },
  );

  const staleFailure = reduceRunSessionState(running, {
    type: 'run_terminal',
    runId: 'stale-run',
    threadId: THREAD_ID_VALUE,
    ok: false,
  });
  const successfulDone = reduceRunSessionState(running, {
    type: 'run_terminal',
    runId: RUN_ID,
    threadId: THREAD_ID_VALUE,
    ok: true,
  });

  assert.equal(staleFailure, running);
  assert.equal(successfulDone, running);
});

void test('run session settle success returns to idle phase', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'run_settled_success',
    },
  );

  assert.equal(running.phase, 'idle');
  assert.equal(getActiveRunId(running), null);
  assert.equal(isRunSessionStarting(running), false);
});

void test('run session settle sync started keeps the streamed view visible while sync is pending', () => {
  const settling = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'run_settle_sync_started',
    },
  );

  assert.equal(settling.phase, 'settling');
  assert.equal(settling.activeRunView.runId, RUN_ID);
  assert.equal(settling.activeRunView.pendingApproval, null);
});

void test('run session settle sync failure preserves streamed output and exposes a sync error', () => {
  const syncFailed = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(
        reduceRunSessionState(createInitialRunSessionState(), {
          type: 'run_start_requested',
          threadId: THREAD_ID_VALUE,
        }),
        {
          type: 'run_started',
          threadId: THREAD_ID_VALUE,
          runId: RUN_ID,
        },
      ),
      {
        type: 'assistant_text_streamed',
        threadId: THREAD_ID_VALUE,
        target: 'answer',
        text: 'final answer',
      },
    ),
    {
      type: 'run_settle_sync_failed',
      threadId: THREAD_ID_VALUE,
      message:
        'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
    },
  );

  assert.equal(syncFailed.phase, 'error');
  assert.equal(syncFailed.activeRunView.runId, RUN_ID);
  assert.equal(syncFailed.activeRunView.finalAnswerText, 'final answer');
  assert.equal(
    syncFailed.activeRunView.streamError,
    'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
  );
});

void test('approval submit failure preserves pending approval and records a visible error until cleared', () => {
  const withPendingApproval = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: 'run-1',
      },
    ),
    {
      type: 'approval_requested',
      threadId: THREAD_ID,
      pendingApproval: makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
      }),
    },
  );

  const withApprovalError = reduceRunSessionState(withPendingApproval, {
    type: 'approval_submit_failed',
    message: '[internal] approval transport down',
  });
  const cleared = reduceRunSessionState(withApprovalError, {
    type: 'approval_cleared',
  });

  assert.equal(
    withApprovalError.activeRunView.pendingApproval?.callId,
    'call-1',
  );
  assert.equal(
    withApprovalError.activeRunView.streamError,
    '[internal] approval transport down',
  );
  assert.equal(cleared.activeRunView.pendingApproval, null);
  assert.equal(cleared.activeRunView.streamError, null);
});

void test('multiple pending approvals are revealed one at a time as each is cleared', () => {
  const firstApproval = makeApprovalRequiredFixture({
    callId: 'approval-call-1',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const secondApproval = makeApprovalRequiredFixture({
    callId: 'approval-call-2',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: RUN_ID,
    },
  );
  const withApprovals = reduceRunSessionState(
    reduceRunSessionState(running, {
      type: 'approval_requested',
      threadId: THREAD_ID_VALUE,
      pendingApproval: firstApproval,
    }),
    {
      type: 'approval_requested',
      threadId: THREAD_ID_VALUE,
      pendingApproval: secondApproval,
    },
  );

  assert.equal(withApprovals.activeRunView.pendingApproval, firstApproval);

  const afterFirstCleared = reduceRunSessionState(withApprovals, {
    type: 'approval_cleared',
    pendingApproval: firstApproval,
  });
  assert.equal(afterFirstCleared.activeRunView.pendingApproval, secondApproval);

  const afterSecondCleared = reduceRunSessionState(afterFirstCleared, {
    type: 'approval_cleared',
    pendingApproval: secondApproval,
  });
  assert.equal(afterSecondCleared.activeRunView.pendingApproval, null);
});

void test('run transcript entries stay structured instead of flattening tool events into commentary text', () => {
  const withEntries = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(
        reduceRunSessionState(createInitialRunSessionState(), {
          type: 'run_start_requested',
          threadId: THREAD_ID_VALUE,
        }),
        {
          type: 'run_started',
          threadId: THREAD_ID_VALUE,
          runId: 'run-1',
        },
      ),
      {
        type: 'assistant_text_streamed',
        threadId: THREAD_ID_VALUE,
        target: 'transcript',
        text: 'Thinking...',
      },
    ),
    {
      type: 'transcript_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'tool_activity',
        tool: 'write_file',
        state: 'running',
      },
    },
  );

  const finished = reduceRunSessionState(withEntries, {
    type: 'transcript_activity_added',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'tool_activity',
      tool: 'write_file',
      state: 'completed',
    },
  });

  assert.deepEqual(finished.activeRunView.transcriptEntries, [
    { kind: 'assistant_text', text: 'Thinking...' },
    { kind: 'tool_activity', tool: 'write_file', state: 'running' },
    { kind: 'tool_activity', tool: 'write_file', state: 'completed' },
  ]);
});

void test('subagent activity appends to the active transcript when the parent thread is visible', () => {
  const state = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'spawned',
      },
    },
  );

  assert.deepEqual(state.activeRunView.transcriptEntries, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'spawned',
    },
  ]);
  assert.deepEqual(state.backgroundNotificationsByThread, {});
});

void test('subagent activity falls back to thread-scoped background notifications when the thread is inactive', () => {
  const state = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'subagent_activity_added',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-1',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  });

  assert.deepEqual(state.activeRunView.transcriptEntries, []);
  assert.deepEqual(state.backgroundNotificationsByThread, {
    [THREAD_ID_VALUE]: [
      {
        kind: 'subagent_activity',
        deliveryId: 'delivery-1',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
  });
});

void test('subagent terminal replay with the same deliveryId is deduped in the active transcript', () => {
  const initial = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-dedupe',
        parentRunId: RUN_ID,
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    },
  );

  const deduped = reduceRunSessionState(initial, {
    type: 'subagent_activity_added',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-dedupe',
      parentRunId: RUN_ID,
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  });

  assert.deepEqual(deduped.activeRunView.transcriptEntries, [
    {
      kind: 'subagent_activity',
      deliveryId: 'delivery-dedupe',
      parentRunId: RUN_ID,
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
  assert.deepEqual(deduped.backgroundNotificationsByThread, {});
});

void test('subagent terminal activity remains visible after the parent run settles', () => {
  const withTerminalActivity = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-before-settle',
        parentRunId: RUN_ID,
        childRunId: 'run-child-before-settle',
        subagentType: 'worker',
        state: 'completed',
        result: 'done before parent settle',
      },
    },
  );

  const settled = reduceRunSessionState(withTerminalActivity, {
    type: 'run_settled_success',
  });

  assert.deepEqual(settled.backgroundNotificationsByThread, {
    [THREAD_ID_VALUE]: [
      {
        kind: 'subagent_activity',
        deliveryId: 'delivery-before-settle',
        parentRunId: RUN_ID,
        childRunId: 'run-child-before-settle',
        subagentType: 'worker',
        state: 'completed',
        result: 'done before parent settle',
      },
    ],
  });
});

void test('artifact_activated preserves finalAnswerText and promotes the committed artifact ref', () => {
  const withFinalAnswer = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: 'run-1',
      },
    ),
    {
      type: 'assistant_text_streamed',
      threadId: THREAD_ID_VALUE,
      target: 'answer',
      text: '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
    },
  );

  const committed = reduceRunSessionState(withFinalAnswer, {
    type: 'artifact_activated',
    threadId: THREAD_ID_VALUE,
    artifact: {
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: '요약',
      contentHash: 'hash',
      createdAt: '2026-03-24T00:00:01.000Z',
      createdByRunId: 'run-1',
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: null,
    },
  });

  assert.equal(
    committed.activeRunView.finalAnswerText,
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
  );
  assert.deepEqual(committed.activeRunView.activeArtifactRef, {
    artifactId: 'art_1',
    version: 1,
  });
});

void test('steer flush request marks the queue and clears on apply or empty', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    { type: 'run_started', threadId: THREAD_ID_VALUE, runId: 'run-1' },
  );

  // 큐가 비어 있으면 플러시 요청은 무시된다
  const flushWithoutQueue = reduceRunSessionState(running, {
    type: 'steer_flush_requested',
    runId: 'run-1',
  });
  assert.equal(
    flushWithoutQueue.activeRunView.pendingSteerFlushRequested,
    false,
  );

  const queuedOne = reduceRunSessionState(running, {
    type: 'steer_queued',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    steer: { receivedSeq: 1, text: 'first steer' },
  });
  const queuedTwo = reduceRunSessionState(queuedOne, {
    type: 'steer_queued',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    steer: { receivedSeq: 2, text: 'second steer' },
  });
  const staleCancel = reduceRunSessionState(queuedTwo, {
    type: 'steer_cancelled',
    runId: 'run-previous',
    receivedSeq: 1,
  });
  const staleFlush = reduceRunSessionState(queuedTwo, {
    type: 'steer_flush_requested',
    runId: 'run-previous',
  });
  assert.equal(staleCancel, queuedTwo);
  assert.equal(staleFlush, queuedTwo);

  const flushRequested = reduceRunSessionState(queuedTwo, {
    type: 'steer_flush_requested',
    runId: 'run-1',
  });
  assert.equal(flushRequested.activeRunView.pendingSteerFlushRequested, true);

  // 소비 1건이면 플러시 플래그는 목적을 다해 내려간다
  const applied = reduceRunSessionState(flushRequested, {
    type: 'steer_applied',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    receivedSeqs: [1],
  });
  assert.equal(applied.activeRunView.pendingSteerFlushRequested, false);
  assert.deepEqual(
    applied.activeRunView.pendingSteers.map((steer) => steer.receivedSeq),
    [2],
  );

  // 취소로 큐가 완전히 비면 플래그도 내려간다
  const flushAgain = reduceRunSessionState(applied, {
    type: 'steer_flush_requested',
    runId: 'run-1',
  });
  assert.equal(flushAgain.activeRunView.pendingSteerFlushRequested, true);
  const emptied = reduceRunSessionState(flushAgain, {
    type: 'steer_cancelled',
    runId: 'run-1',
    receivedSeq: 2,
  });
  assert.equal(emptied.activeRunView.pendingSteers.length, 0);
  assert.equal(emptied.activeRunView.pendingSteerFlushRequested, false);
});

void test('tool_call_args_streamed accumulates into a live entry and the full tool_call closes it', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-stream-1',
  });

  const first = reduceRunSessionState(running, {
    type: 'tool_call_args_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call_viz',
    tool: 'visualize',
    argsDelta: '{"code":"<svg',
  });
  const second = reduceRunSessionState(first, {
    type: 'tool_call_args_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call_viz',
    tool: 'visualize',
    argsDelta: '></svg>"}',
  });

  assert.deepEqual(second.activeRunView.streamingToolCall, {
    callId: 'call_viz',
    tool: 'visualize',
    argsText: '{"code":"<svg></svg>"}',
  });
  // 스트리밍 중에는 라이브 꼬리 엔트리로 보인다
  const visible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: second,
  });
  assert.deepEqual(visible.transcriptEntries.at(-1), {
    kind: 'tool_activity',
    tool: 'visualize',
    state: 'running',
    argsText: '{"code":"<svg></svg>"}',
  });

  // 다른 스레드의 델타는 무시
  const mismatched = reduceRunSessionState(second, {
    type: 'tool_call_args_streamed',
    threadId: OTHER_THREAD_ID_VALUE,
    callId: 'call_viz',
    tool: 'visualize',
    argsDelta: 'x',
  });
  assert.equal(
    mismatched.activeRunView.streamingToolCall?.argsText,
    '{"code":"<svg></svg>"}',
  );

  // 완성본 tool_call이 스트리밍을 닫고 일반 엔트리가 대체한다
  const settled = reduceRunSessionState(mismatched, {
    type: 'transcript_activity_added',
    threadId: THREAD_ID_VALUE,
    streamedToolCallId: 'call_viz',
    entry: {
      kind: 'tool_activity',
      tool: 'visualize',
      state: 'running',
      args: { code: '<svg></svg>' },
    },
  });
  assert.equal(settled.activeRunView.streamingToolCall, null);
  const settledVisible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: settled,
  });
  assert.equal(
    settledVisible.transcriptEntries.filter(
      (entry) => entry.kind === 'tool_activity' && entry.tool === 'visualize',
    ).length,
    1,
  );
});

void test('tool_output_streamed accumulates only on the matching live tool call', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-stream-output',
  });
  const withCall = reduceRunSessionState(running, {
    type: 'transcript_activity_added',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'tool_activity',
      tool: 'exec_command',
      state: 'running',
      callId: 'call-exec',
    },
  });
  const withStdout = reduceRunSessionState(withCall, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'hello ',
  });
  const withBothStreams = reduceRunSessionState(withStdout, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stderr',
    text: 'warning',
  });
  const completed = reduceRunSessionState(withBothStreams, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'world',
  });

  assert.deepEqual(completed.activeRunView.transcriptEntries[0], {
    kind: 'tool_activity',
    tool: 'exec_command',
    state: 'running',
    callId: 'call-exec',
    output: {
      stdout: 'hello world',
      stderr: 'warning',
    },
  });

  const mismatched = reduceRunSessionState(completed, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'another-call',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'must-not-appear',
  });
  assert.equal(mismatched, completed);
});
