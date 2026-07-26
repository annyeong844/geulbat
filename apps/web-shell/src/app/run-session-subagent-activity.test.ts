import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySubagentActivity,
  preserveSettledSubagentActivities,
} from './run-session-subagent-activity.js';
import {
  createEmptyActiveRunView,
  type RunSessionState,
} from './run-session-state-types.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';

function createState(
  overrides: Partial<RunSessionState> = {},
): RunSessionState {
  return {
    phase: 'idle',
    pendingStartThreadId: null,
    activeRunView: createEmptyActiveRunView(),
    sessionError: null,
    backgroundNotificationsByThread: {},
    contextUsageByThread: {},
    ...overrides,
  };
}

void test('applySubagentActivity appends to the active transcript for the visible running thread', () => {
  const state = createState({
    phase: 'running',
    activeRunView: createEmptyActiveRunView(THREAD_ID),
  });

  const next = applySubagentActivity(state, THREAD_ID, {
    kind: 'subagent_activity',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'spawned',
  });

  assert.deepEqual(next.activeRunView.transcriptEntries, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'spawned',
    },
  ]);
  assert.deepEqual(next.backgroundNotificationsByThread, {});
});

void test('applySubagentActivity keeps terminal activity in the active answer transcript', () => {
  const state = createState({
    phase: 'running',
    activeRunView: {
      ...createEmptyActiveRunView(THREAD_ID),
      runId: 'run-parent-1',
    },
  });
  const entry = {
    kind: 'subagent_activity' as const,
    parentRunId: 'run-parent-1',
    childRunId: 'run-child-1',
    subagentType: 'worker' as const,
    state: 'completed' as const,
    deliveryId: 'delivery-1',
  };

  const next = applySubagentActivity(state, THREAD_ID, entry);

  assert.deepEqual(next.activeRunView.transcriptEntries, [entry]);
  assert.deepEqual(next.backgroundNotificationsByThread, {});
});

void test('applySubagentActivity keeps a late child result with its earlier parent run', () => {
  const state = createState({
    phase: 'running',
    activeRunView: {
      ...createEmptyActiveRunView(THREAD_ID),
      runId: 'run-parent-new',
    },
  });
  const entry = {
    kind: 'subagent_activity' as const,
    parentRunId: 'run-parent-old',
    childRunId: 'run-child-old',
    subagentType: 'worker' as const,
    state: 'completed' as const,
    deliveryId: 'delivery-old',
  };

  const next = applySubagentActivity(state, THREAD_ID, entry);

  assert.deepEqual(next.activeRunView.transcriptEntries, []);
  assert.deepEqual(next.backgroundNotificationsByThread, {
    [THREAD_ID]: [entry],
  });
});

void test('applySubagentActivity falls back to thread background notifications when the thread is inactive', () => {
  const state = createState({
    phase: 'running',
    activeRunView: createEmptyActiveRunView('other-thread'),
  });

  const next = applySubagentActivity(state, THREAD_ID, {
    kind: 'subagent_activity',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'spawned',
  });

  assert.deepEqual(next.activeRunView.transcriptEntries, []);
  assert.deepEqual(next.backgroundNotificationsByThread, {
    [THREAD_ID]: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'spawned',
      },
    ],
  });
});

void test('applySubagentActivity replaces a child lifecycle snapshot instead of accumulating stale states', () => {
  const spawned = applySubagentActivity(
    createState({
      phase: 'running',
      activeRunView: createEmptyActiveRunView('other-thread'),
    }),
    THREAD_ID,
    {
      kind: 'subagent_activity',
      parentRunId: 'run-parent-1',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'spawned',
    },
  );

  const completed = applySubagentActivity(spawned, THREAD_ID, {
    kind: 'subagent_activity',
    parentRunId: 'run-parent-1',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'completed',
    deliveryId: 'delivery-1',
  });

  assert.deepEqual(completed.backgroundNotificationsByThread[THREAD_ID], [
    {
      kind: 'subagent_activity',
      parentRunId: 'run-parent-1',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
      deliveryId: 'delivery-1',
    },
  ]);
});

void test('preserveSettledSubagentActivities keeps children that outlive their parent answer', () => {
  const state = createState({
    phase: 'settling',
    activeRunView: {
      ...createEmptyActiveRunView(THREAD_ID),
      runId: 'run-parent-1',
      transcriptEntries: [
        {
          kind: 'subagent_activity',
          parentRunId: 'run-parent-1',
          childRunId: 'run-child-1',
          subagentType: 'worker',
          state: 'spawned',
        },
      ],
    },
  });

  const next = preserveSettledSubagentActivities(state);

  assert.deepEqual(next.backgroundNotificationsByThread[THREAD_ID], [
    {
      kind: 'subagent_activity',
      parentRunId: 'run-parent-1',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'spawned',
    },
  ]);
});

void test('applySubagentActivity returns the same state when a terminal replay delivery is deduped', () => {
  const entry = {
    kind: 'subagent_activity' as const,
    childRunId: 'run-child-1',
    subagentType: 'worker' as const,
    state: 'completed' as const,
    deliveryId: 'delivery-1',
  };
  const state = createState({
    phase: 'running',
    activeRunView: {
      ...createEmptyActiveRunView(THREAD_ID),
    },
    backgroundNotificationsByThread: {
      [THREAD_ID]: [entry],
    },
  });

  const next = applySubagentActivity(state, THREAD_ID, entry);

  assert.equal(next, state);
});
