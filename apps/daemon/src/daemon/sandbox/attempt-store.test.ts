import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxAttemptStore } from './attempt-store.js';

void test('sandbox attempt store tracks queued running and terminal status', () => {
  const store = createSandboxAttemptStore({
    now: (() => {
      const times = [
        '2026-05-17T00:00:00.000Z',
        '2026-05-17T00:00:01.000Z',
        '2026-05-17T00:00:02.000Z',
      ];
      return () => times.shift() ?? '2026-05-17T00:00:03.000Z';
    })(),
  });

  const attempt = store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
    owner: { runId: 'run-sandbox-1' },
  });

  assert.equal(attempt.status, 'queued');
  assert.equal(attempt.jobId, 'sandbox-job-1');
  assert.equal(attempt.attemptId, 'sandbox-attempt-1');

  store.markRunning(attempt.attemptId, {
    rootPath: '/tmp/geulbat-sandbox/sandbox-attempt-1',
  });
  store.markTerminal(attempt.attemptId, {
    status: 'succeeded',
    exitCode: 0,
    diagnostics: 'probe ok',
    outputRef: {
      evidenceRef: 'sandbox-output:sandbox-evidence-1',
      rootPath: '/tmp/geulbat-sandbox/sandbox-evidence-1/files',
      files: [
        {
          relativePath: 'result.json',
          bytes: 18,
          sha256:
            'bb176588fc77624ae0f3df1d73ed8655fae0ef109693ec24a7b03f1f78cc728e',
        },
      ],
      totalBytes: 18,
    },
  });

  const snapshot = store.getAttempt(attempt.attemptId);
  assert.equal(snapshot?.status, 'succeeded');
  assert.equal(snapshot?.startedAt, '2026-05-17T00:00:01.000Z');
  assert.equal(snapshot?.completedAt, '2026-05-17T00:00:02.000Z');
  assert.equal(snapshot?.diagnostics, 'probe ok');
  assert.equal(snapshot?.outputRef?.files[0]?.relativePath, 'result.json');
});

void test('sandbox retry creates a new attempt and preserves prior terminal diagnostics', () => {
  const store = createSandboxAttemptStore({
    now: () => '2026-05-17T00:00:00.000Z',
  });
  const first = store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
    owner: { runId: 'run-sandbox-retry' },
  });

  store.markRunning(first.attemptId, { rootPath: '/tmp/first' });
  store.markTerminal(first.attemptId, {
    status: 'timed_out',
    diagnostics: 'timed out after 5ms',
  });

  const second = store.retryAttempt(first.attemptId);

  assert.equal(second.jobId, first.jobId);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(second.previousAttemptId, first.attemptId);
  assert.equal(store.getAttempt(first.attemptId)?.status, 'timed_out');
  assert.equal(
    store.getAttempt(first.attemptId)?.diagnostics,
    'timed out after 5ms',
  );
  assert.equal(store.getAttempt(second.attemptId)?.status, 'queued');
});

void test('sandbox retry rejects non-terminal attempts', () => {
  const store = createSandboxAttemptStore({
    now: () => '2026-05-17T00:00:00.000Z',
  });
  const queued = store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
  });
  const running = store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
  });
  store.markRunning(running.attemptId, { rootPath: '/tmp/running' });

  assert.throws(
    () => store.retryAttempt(queued.attemptId),
    /cannot retry non-terminal sandbox attempt/,
  );
  assert.throws(
    () => store.retryAttempt(running.attemptId),
    /cannot retry non-terminal sandbox attempt/,
  );

  assert.equal(store.getAttempts().records.length, 2);
});
