import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import {
  getActiveRunId,
  isRunSessionStarting,
  selectVisibleRunState,
} from './run-session-state-selectors.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import { createEmptyActiveRunView } from './run-session-state-types.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const OTHER_THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000002';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

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

void test('context usage snapshots persist per thread until the next exact measurement replaces them', () => {
  const measured = {
    state: 'measured' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
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
  const settled = reduceRunSessionState(measuredState, {
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
  const withApprovals = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
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

void test('subagent terminal replay with the same deliveryId is deduped in thread notifications', () => {
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
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  });

  assert.deepEqual(deduped.activeRunView.transcriptEntries, []);
  assert.equal(
    deduped.backgroundNotificationsByThread[THREAD_ID_VALUE]?.length,
    1,
  );
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

void test('selectVisibleRunState only exposes run details for the selected thread', () => {
  const visible = selectVisibleRunState({
    selectedThreadId: OTHER_THREAD_ID_VALUE,
    state: {
      phase: 'starting',
      pendingStartThreadId: THREAD_ID_VALUE,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: 'run-1',
        transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
        finalAnswerText: 'final',
        pendingApproval: makeApprovalRequiredFixture({
          runId: RUN_ID,
          threadId: THREAD_ID,
        }),
        streamError: '[internal] failed',
      },
      sessionError: null,
      backgroundNotificationsByThread: {
        [THREAD_ID_VALUE]: [
          {
            kind: 'subagent_activity',
            childRunId: 'run-child-1',
            subagentType: 'worker',
            state: 'failed',
          },
        ],
        [OTHER_THREAD_ID_VALUE]: [
          {
            kind: 'subagent_activity',
            childRunId: 'run-child-2',
            subagentType: 'explorer',
            state: 'completed',
          },
        ],
      },
      contextUsageByThread: {},
    },
  });

  assert.equal(visible.isRunning, false);
  assert.equal(visible.visibleThreadId, OTHER_THREAD_ID_VALUE);
  assert.equal(visible.activeRunId, null);
  assert.deepEqual(visible.transcriptEntries, []);
  assert.equal(visible.finalAnswerText, '');
  assert.equal(visible.streamError, null);
  assert.equal(visible.pendingApproval, null);
  assert.deepEqual(visible.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-2',
      subagentType: 'explorer',
      state: 'completed',
    },
  ]);
});

void test('selectVisibleRunState keeps an acknowledged new-thread run visible before thread selection catches up', () => {
  const visible = selectVisibleRunState({
    selectedThreadId: null,
    state: {
      phase: 'running',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: 'run-1',
        transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
        finalAnswerText: 'final',
        pendingApproval: makeApprovalRequiredFixture({
          runId: RUN_ID,
          threadId: THREAD_ID,
        }),
        streamError: '[internal] failed',
      },
      sessionError: null,
      backgroundNotificationsByThread: {
        [THREAD_ID_VALUE]: [
          {
            kind: 'subagent_activity',
            childRunId: 'run-child-1',
            subagentType: 'worker',
            state: 'failed',
          },
        ],
      },
      contextUsageByThread: {},
    },
  });

  assert.equal(visible.isRunning, true);
  assert.equal(visible.visibleThreadId, THREAD_ID_VALUE);
  assert.equal(visible.activeRunId, 'run-1');
  assert.deepEqual(visible.transcriptEntries, [
    { kind: 'assistant_text', text: 'commentary' },
  ]);
  assert.equal(visible.finalAnswerText, 'final');
  assert.equal(visible.pendingApproval?.threadId, THREAD_ID_VALUE);
  assert.equal(visible.streamError, '[internal] failed');
  assert.deepEqual(visible.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'failed',
    },
  ]);
});

void test('selectVisibleRunState surfaces a worker(child)-run approval on the owning parent session', () => {
  const childThreadIdValue = '00000000-0000-4000-8000-000000000777';
  const visible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: {
      phase: 'running',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: 'run-1',
        // Approval payload carries the child run/thread identity, which is
        // what run.approve must send back — visibility is keyed to the
        // parent session that owns the run, not the payload threadId.
        pendingApproval: makeApprovalRequiredFixture({
          runId: brandRunId('run-child-1'),
          threadId: brandThreadId(childThreadIdValue),
        }),
      },
      sessionError: null,
      backgroundNotificationsByThread: {},
      contextUsageByThread: {},
    },
  });

  assert.equal(visible.pendingApproval?.threadId, childThreadIdValue);
  assert.equal(visible.pendingApproval?.runId, 'run-child-1');
});

void test('selectVisibleRunState keeps a settling run visible without reporting it as still running', () => {
  const visible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: {
      phase: 'settling',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: 'run-1',
        finalAnswerText: 'final',
        streamError: null,
      },
      sessionError: null,
      backgroundNotificationsByThread: {},
      contextUsageByThread: {},
    },
  });

  assert.equal(visible.activeRunId, 'run-1');
  assert.equal(visible.finalAnswerText, 'final');
  assert.equal(visible.isRunning, false);
  assert.equal(visible.isSettling, true);
});

void test('selectVisibleRunState falls back to session-level error when no thread-scoped run state is visible', () => {
  const visible = selectVisibleRunState({
    selectedThreadId: OTHER_THREAD_ID_VALUE,
    state: {
      phase: 'idle',
      pendingStartThreadId: null,
      activeRunView: createEmptyActiveRunView(null),
      sessionError: '[internal] socket down',
      backgroundNotificationsByThread: {},
      contextUsageByThread: {},
    },
  });

  assert.equal(visible.streamError, '[internal] socket down');
  assert.equal(visible.visibleThreadId, OTHER_THREAD_ID_VALUE);
  assert.equal(visible.isRunning, false);
  assert.equal(visible.isSettling, false);
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
  });
  assert.equal(
    flushWithoutQueue.activeRunView.pendingSteerFlushRequested,
    false,
  );

  const queuedOne = reduceRunSessionState(running, {
    type: 'steer_queued',
    threadId: THREAD_ID_VALUE,
    steer: { receivedSeq: 1, text: 'first steer' },
  });
  const queuedTwo = reduceRunSessionState(queuedOne, {
    type: 'steer_queued',
    threadId: THREAD_ID_VALUE,
    steer: { receivedSeq: 2, text: 'second steer' },
  });
  const flushRequested = reduceRunSessionState(queuedTwo, {
    type: 'steer_flush_requested',
  });
  assert.equal(flushRequested.activeRunView.pendingSteerFlushRequested, true);

  // 소비 1건이면 플러시 플래그는 목적을 다해 내려간다
  const applied = reduceRunSessionState(flushRequested, {
    type: 'steer_applied',
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
  });
  assert.equal(flushAgain.activeRunView.pendingSteerFlushRequested, true);
  const emptied = reduceRunSessionState(flushAgain, {
    type: 'steer_cancelled',
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
