import test from 'node:test';
import assert from 'node:assert/strict';

import { createActiveRunStore } from '../../sessions/active-runs.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { startManagedRun } from './managed-run.js';

void test('startManagedRun registers and cleans up an active run', () => {
  const activeRuns = createActiveRunStore();
  const threadId = testThreadId(1);
  const abortController = new AbortController();
  const started = startManagedRun(
    {
      runContext: makeRunContext({
        threadId,
      }),
      abortController,
    },
    { activeRuns },
  );

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  assert.equal(started.runState.abortController, abortController);
  assert.equal(started.activeRun.abortController, abortController);
  assert.equal(activeRuns.getRunById(started.runId)?.threadId, threadId);

  started.finish();
  assert.equal(activeRuns.getRunById(started.runId), undefined);
});

void test('getRunById returns a snapshot instead of the live active-run object', () => {
  const activeRuns = createActiveRunStore();
  const threadId = testThreadId(2);
  const started = startManagedRun(
    {
      runContext: makeRunContext({
        threadId,
      }),
    },
    { activeRuns },
  );

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const snapshot = activeRuns.getRunById(started.runId);
  assert.ok(snapshot);
  const mutableSnapshot = snapshot as {
    threadId: ReturnType<typeof testThreadId>;
    ownerThreadId: ReturnType<typeof testThreadId>;
  };
  mutableSnapshot.threadId = testThreadId(999);
  mutableSnapshot.ownerThreadId = testThreadId(998);

  const after = activeRuns.getRunById(started.runId);
  assert.equal(after?.threadId, threadId);
  assert.equal(after?.ownerThreadId, threadId);
  assert.equal(after?.aborted, false);
  assert.equal('abortController' in (after ?? {}), false);
  assert.equal('interject' in (after ?? {}), false);

  started.finish();
});

void test('startManagedRun shares the interject buffer with the active run store', () => {
  const activeRuns = createActiveRunStore();
  const threadId = testThreadId(8);
  const started = startManagedRun(
    {
      runContext: makeRunContext({
        threadId,
      }),
    },
    { activeRuns },
  );

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  assert.equal(started.activeRun.interject, started.runState.interject);
  assert.deepEqual(
    activeRuns.appendPendingInterject(started.runId, { text: 'note' }),
    {
      ok: true,
      receivedSeq: 1,
      bufferDepth: 1,
    },
  );
  assert.deepEqual(started.runState.interject.items, [
    { text: 'note', receivedSeq: 1 },
  ]);
  assert.equal(
    'interject' in (activeRuns.getRunById(started.runId) ?? {}),
    false,
  );

  started.finish();
});

void test('startManagedRun reports thread conflicts without replacing the active run', () => {
  const activeRuns = createActiveRunStore();
  const threadId = testThreadId(3);
  const first = startManagedRun(
    {
      runContext: makeRunContext({
        threadId,
      }),
    },
    { activeRuns },
  );

  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }

  const second = startManagedRun(
    {
      runContext: makeRunContext({
        threadId,
      }),
    },
    { activeRuns },
  );

  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.activeRunId, first.runId);
  }

  first.finish();
});

void test('startManagedRun allows a new top-level run on the owner thread while a background child run is still active', () => {
  const activeRuns = createActiveRunStore();
  const ownerThreadId = testThreadId(6);
  const childThreadId = testThreadId(7);

  const parent = startManagedRun(
    {
      runId: 'run-parent-owner',
      runContext: makeRunContext({
        threadId: ownerThreadId,
      }),
      ownerThreadId,
    },
    { activeRuns },
  );
  assert.equal(parent.ok, true);
  if (!parent.ok) {
    return;
  }

  const child = startManagedRun(
    {
      runId: 'run-child-background',
      runContext: makeRunContext({
        threadId: childThreadId,
      }),
      ownerThreadId,
      parentRunId: parent.runId,
    },
    { activeRuns },
  );
  assert.equal(child.ok, true);
  if (!child.ok) {
    parent.finish();
    return;
  }

  parent.finish();

  const nextTopLevel = startManagedRun(
    {
      runId: 'run-parent-next-turn',
      runContext: makeRunContext({
        threadId: ownerThreadId,
      }),
      ownerThreadId,
    },
    { activeRuns },
  );

  assert.equal(nextTopLevel.ok, true);
  if (nextTopLevel.ok) {
    nextTopLevel.finish();
  }
  child.finish();
});
