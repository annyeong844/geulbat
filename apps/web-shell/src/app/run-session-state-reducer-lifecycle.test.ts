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

import {
  OTHER_THREAD_ID_VALUE,
  RUN_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';

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
