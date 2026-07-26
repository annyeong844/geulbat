import assert from 'node:assert/strict';
import test from 'node:test';

import { assertThreadId } from './ids.js';
import {
  isGoalCommand,
  isGoalRef,
  isGoalSnapshot,
  type GoalSnapshot,
} from './goal.js';

const snapshot: GoalSnapshot = {
  goalId: 'goal-1',
  threadId: assertThreadId('123e4567-e89b-42d3-a456-426614174083'),
  objective: 'Ship the verified Goal mode.',
  state: 'verifying',
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:01:00.000Z',
};

void test('Goal guards accept the closed public lifecycle contract', () => {
  assert.equal(isGoalSnapshot(snapshot), true);
  assert.equal(isGoalRef({ goalId: snapshot.goalId }), true);
  assert.equal(
    isGoalCommand({
      kind: 'resume',
      threadId: snapshot.threadId,
      goalId: snapshot.goalId,
    }),
    true,
  );
});

void test('Goal guards reject hidden verifier details and unknown commands', () => {
  assert.equal(
    isGoalSnapshot({
      ...snapshot,
      votes: [{ verdict: 'achieved' }],
    }),
    false,
  );
  assert.equal(
    isGoalCommand({
      kind: 'complete',
      threadId: snapshot.threadId,
      goalId: snapshot.goalId,
    }),
    false,
  );
});
