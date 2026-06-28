import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { withRunningSandboxAttemptRoot } from './attempt-root.js';
import { createSandboxAttemptStore } from './attempt-store.js';

void test('withRunningSandboxAttemptRoot terminalizes a running attempt when the run body throws', async () => {
  const store = createSandboxAttemptStore();
  const attempt = store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
  });

  await assert.rejects(
    () =>
      withRunningSandboxAttemptRoot({
        attemptId: attempt.attemptId,
        store,
        onRootFailure: () => {
          assert.fail('root creation should not fail');
        },
        run: async () => {
          throw new Error('run body failed');
        },
      }),
    /run body failed/u,
  );

  const snapshot = store.getAttempt(attempt.attemptId);
  assert.equal(snapshot?.status, 'failed');
  assert.equal(snapshot?.diagnostics, 'sandbox_run_failed');
  assert.equal(snapshot?.exitCode, null);
  assert.ok(snapshot?.completedAt);
  const rootPath = snapshot?.rootPath;
  if (typeof rootPath !== 'string') {
    assert.fail('expected rootPath to be recorded before failure');
  }
  await assert.rejects(() => access(rootPath));
});

void test('withRunningSandboxAttemptRoot preserves a terminal attempt when the run body throws after closing it', async () => {
  const store = createSandboxAttemptStore();
  const attempt = store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
  });

  await assert.rejects(
    () =>
      withRunningSandboxAttemptRoot({
        attemptId: attempt.attemptId,
        store,
        onRootFailure: () => {
          assert.fail('root creation should not fail');
        },
        run: async () => {
          store.markTerminal(attempt.attemptId, {
            status: 'cancelled',
            diagnostics: 'domain_cancelled',
          });
          throw new Error('domain cancelled');
        },
      }),
    /domain cancelled/u,
  );

  const snapshot = store.getAttempt(attempt.attemptId);
  assert.equal(snapshot?.status, 'cancelled');
  assert.equal(snapshot?.diagnostics, 'domain_cancelled');
});
