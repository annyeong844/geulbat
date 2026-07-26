import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { createGoalStore } from './goal-store.js';

const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174080');
const verificationRunId = assertRunId('run-goal-verification');

function executionTemplate() {
  return {
    workingDirectory: '/workspace',
    permissionMode: 'basic' as const,
  };
}

void test('Goal state persists work, private verification evidence, pause, resume, and completion', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'goal-store-'));
  let tick = 0;
  const store = createGoalStore({
    stateRoot,
    createId: () => 'fixed',
    now: () => `2026-07-26T00:00:0${tick++}.000Z`,
  });

  const started = await store.enterOrResume({
    threadId,
    requested: true,
    objective: 'Ship Goal mode',
    executionTemplate: executionTemplate(),
  });
  assert.equal(started?.state, 'working');
  assert.equal(started?.goalId, 'goal-fixed');
  if (started === null) {
    return;
  }

  assert.equal(
    (
      await store.requestVerification({
        threadId,
        goalId: started.goalId,
        runId: verificationRunId,
      })
    ).state,
    'verifying',
  );
  const continuing = await store.recordVerification({
    threadId,
    goalId: started.goalId,
    runId: verificationRunId,
    outcome: {
      kind: 'incomplete',
      unmetRequirements: ['Run the focused verification'],
    },
    votes: [
      {
        verdict: 'not_achieved',
        unmetRequirements: ['Run the focused verification'],
      },
      {
        verdict: 'not_achieved',
        unmetRequirements: ['Run the focused verification'],
      },
      { verdict: 'achieved' },
    ],
  });
  assert.equal(continuing.state, 'continuing');
  assert.equal('votes' in continuing, false);

  const persisted = JSON.parse(
    await readFile(
      join(stateRoot, '.geulbat', 'goals', `${threadId}.json`),
      'utf8',
    ),
  ) as {
    current: {
      verificationAttempts: Array<{ votes: unknown[] }>;
    };
  };
  assert.equal(persisted.current.verificationAttempts[0]?.votes.length, 3);

  const paused = await store.applyCommand({
    kind: 'pause',
    threadId,
    goalId: started.goalId,
  });
  assert.equal(paused.snapshot?.state, 'paused');
  const resume = await store.applyCommand({
    kind: 'resume',
    threadId,
    goalId: started.goalId,
  });
  assert.equal(resume.snapshot?.state, 'paused');
  assert.deepEqual(resume.executionTemplate, executionTemplate());
  const resumed = await store.resumeForRun({
    threadId,
    ref: { goalId: started.goalId },
    executionTemplate: executionTemplate(),
  });
  assert.equal(resumed.state, 'working');

  const completionRunId = assertRunId('run-goal-completion');
  await store.requestVerification({
    threadId,
    goalId: started.goalId,
    runId: completionRunId,
  });
  await store.recordVerification({
    threadId,
    goalId: started.goalId,
    runId: completionRunId,
    outcome: { kind: 'achieved' },
    votes: [
      { verdict: 'achieved' },
      { verdict: 'achieved' },
      {
        verdict: 'not_achieved',
        unmetRequirements: ['Minor dissent'],
      },
    ],
  });

  const restarted = createGoalStore({ stateRoot });
  assert.equal((await restarted.readThread(threadId))?.state, 'completed');
});

void test('an interrupted verification recovers as unavailable instead of silently completing', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'goal-recovery-'));
  const store = createGoalStore({
    stateRoot,
    createId: () => 'recovery',
  });
  const started = await store.enterOrResume({
    threadId,
    requested: true,
    objective: 'Recover verification safely',
    executionTemplate: executionTemplate(),
  });
  assert.ok(started);
  await store.requestVerification({
    threadId,
    goalId: started.goalId,
    runId: verificationRunId,
  });

  const restarted = createGoalStore({ stateRoot });
  assert.equal(
    (await restarted.readThread(threadId))?.state,
    'verification_unavailable',
  );
});
