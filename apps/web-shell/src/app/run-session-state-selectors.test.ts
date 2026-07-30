import test from 'node:test';
import assert from 'node:assert/strict';

import { selectVisibleRunState } from './run-session-state-selectors.js';
import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import { createEmptyActiveRunView } from './run-session-state-types.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import {
  OTHER_THREAD_ID_VALUE,
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';

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
  const pendingApproval = makeApprovalRequiredFixture({
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  let state = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'run_start_requested',
    threadId: null,
  });
  state = reduceRunSessionState(state, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: RUN_ID,
  });
  state = reduceRunSessionState(state, {
    type: 'assistant_text_streamed',
    threadId: THREAD_ID_VALUE,
    target: 'transcript',
    text: 'commentary',
  });
  state = reduceRunSessionState(state, {
    type: 'assistant_text_streamed',
    threadId: THREAD_ID_VALUE,
    target: 'answer',
    text: 'final',
  });
  state = reduceRunSessionState(state, {
    type: 'approval_requested',
    runId: RUN_ID,
    threadId: THREAD_ID_VALUE,
    pendingApproval,
  });
  state = reduceRunSessionState(state, {
    type: 'approval_submit_failed',
    threadId: THREAD_ID_VALUE,
    message: '[internal] failed',
  });

  const visible = selectVisibleRunState({
    selectedThreadId: null,
    state,
  });

  assert.equal(visible.isRunning, true);
  assert.equal(visible.visibleThreadId, THREAD_ID_VALUE);
  assert.equal(visible.activeRunId, RUN_ID);
  assert.deepEqual(visible.transcriptEntries, [
    { kind: 'assistant_text', text: 'commentary' },
    { kind: 'approval_request', pendingApproval },
  ]);
  assert.equal(visible.finalAnswerText, 'final');
  assert.equal(visible.pendingApproval?.threadId, THREAD_ID_VALUE);
  assert.equal(visible.streamError, '[internal] failed');
  assert.deepEqual(visible.backgroundNotifications, []);
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

void test('selectVisibleRunState only exposes active run state for the selected thread', () => {
  const state = selectVisibleRunState({
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

  assert.equal(state.isRunning, false);
  assert.equal(state.visibleThreadId, OTHER_THREAD_ID_VALUE);
  assert.equal(state.activeRunId, null);
  assert.deepEqual(state.transcriptEntries, []);
  assert.equal(state.finalAnswerText, '');
  assert.equal(state.streamError, null);
  assert.equal(state.pendingApproval, null);
  assert.deepEqual(state.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-2',
      subagentType: 'explorer',
      state: 'completed',
    },
  ]);
});

void test('selectVisibleRunState keeps threadless transport errors visible for the new-thread composer', () => {
  const state = selectVisibleRunState({
    selectedThreadId: null,
    state: {
      phase: 'error',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(null),
        streamError: '[internal] socket down',
      },
      sessionError: null,
      backgroundNotificationsByThread: {},
      contextUsageByThread: {},
    },
  });

  assert.equal(state.visibleThreadId, null);
  assert.equal(state.streamError, '[internal] socket down');
  assert.equal(state.isRunning, false);
});
