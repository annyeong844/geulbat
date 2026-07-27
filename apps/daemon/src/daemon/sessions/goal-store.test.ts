import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { createGoalStore } from './goal-store.js';

const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174080');
const completionRunId = assertRunId('run-goal-completion');

function executionTemplate() {
  return {
    workingDirectory: '/workspace',
    permissionMode: 'basic' as const,
  };
}

void test('Goal state persists work, pause, resume, and deterministic completion admission', async () => {
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

  assert.equal(
    (
      await store.requestCompletion({
        threadId,
        goalId: started.goalId,
        runId: completionRunId,
      })
    ).state,
    'verifying',
  );
  await store.admitCompletion({
    threadId,
    goalId: started.goalId,
    runId: completionRunId,
  });

  const persisted = JSON.parse(
    await readFile(
      join(stateRoot, '.geulbat', 'goals', `${threadId}.json`),
      'utf8',
    ),
  ) as {
    schemaVersion: number;
    current: {
      completionAdmissions: Array<{ runId: string; admittedAt: string }>;
      legacyVerificationAttempts: unknown[];
    };
  };
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(
    persisted.current.completionAdmissions[0]?.runId,
    completionRunId,
  );
  assert.equal(persisted.current.legacyVerificationAttempts.length, 0);

  const restarted = createGoalStore({ stateRoot });
  assert.equal((await restarted.readThread(threadId))?.state, 'completed');
});

void test('an interrupted completion admission recovers as unavailable instead of silently completing', async () => {
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
  await store.requestCompletion({
    threadId,
    goalId: started.goalId,
    runId: completionRunId,
  });

  const restarted = createGoalStore({ stateRoot });
  assert.equal(
    (await restarted.readThread(threadId))?.state,
    'verification_unavailable',
  );
});

void test('version 1 panel evidence remains readable and is preserved by a version 2 completion admission', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'goal-store-migration-'));
  const goalDirectory = join(stateRoot, '.geulbat', 'goals');
  await mkdir(goalDirectory, { recursive: true });
  await writeFile(
    join(goalDirectory, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      current: {
        snapshot: {
          goalId: 'goal-legacy',
          threadId,
          objective: 'Preserve legacy panel evidence',
          state: 'working',
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:01:00.000Z',
        },
        executionTemplate: executionTemplate(),
        verificationAttempts: [
          {
            runId: 'run-legacy-panel',
            attemptedAt: '2026-07-26T00:01:00.000Z',
            outcome: { kind: 'achieved' },
            votes: [{ verdict: 'achieved' }, { verdict: 'achieved' }],
          },
        ],
      },
    })}\n`,
    'utf8',
  );
  const store = createGoalStore({ stateRoot });
  const legacy = await store.readThread(threadId);
  assert.equal(legacy?.state, 'working');
  assert.ok(legacy);

  await store.requestCompletion({
    threadId,
    goalId: legacy.goalId,
    runId: completionRunId,
  });
  await store.admitCompletion({
    threadId,
    goalId: legacy.goalId,
    runId: completionRunId,
  });

  const migrated = JSON.parse(
    await readFile(join(goalDirectory, `${threadId}.json`), 'utf8'),
  ) as {
    schemaVersion: number;
    current: {
      completionAdmissions: unknown[];
      legacyVerificationAttempts: Array<{ votes: unknown[] }>;
    };
  };
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.current.completionAdmissions.length, 1);
  assert.equal(migrated.current.legacyVerificationAttempts[0]?.votes.length, 2);
});
