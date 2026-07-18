import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunId } from '@geulbat/protocol/ids';

import {
  type ActiveRun,
  type ActiveRunStore,
  createActiveRunStore,
} from './active-runs.js';
import {
  closeInterjectBuffer,
  createRunInterjectBuffer,
} from './active-run-interject-buffer.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type ActiveRunById = NonNullable<ReturnType<ActiveRunStore['getRunById']>>;
type ActiveRunConflict = Extract<
  ReturnType<ActiveRunStore['tryStartRun']>,
  { ok: false }
>;

type _ActiveRunRunIdIsBranded = Expect<Equal<ActiveRun['runId'], RunId>>;
type _ActiveRunParentRunIdIsBranded = Expect<
  Equal<NonNullable<ActiveRun['parentRunId']>, RunId>
>;
type _ActiveRunSnapshotRunIdIsBranded = Expect<
  Equal<ActiveRunById['runId'], RunId>
>;
type _ActiveRunSnapshotParentRunIdIsBranded = Expect<
  Equal<NonNullable<ActiveRunById['parentRunId']>, RunId>
>;
type _ActiveRunConflictIdIsBranded = Expect<
  Equal<ActiveRunConflict['activeRunId'], RunId>
>;

void test('abortRun rejects direct child cancellation', () => {
  const store = createActiveRunStore();
  const parentThreadId = testThreadId(1);
  const childThreadId = testThreadId(2);
  const parentRunId = testRunId('parent');
  const childRunId = testRunId('child');
  const parentController = new AbortController();
  const childController = new AbortController();

  assert.deepEqual(
    store.tryStartRun(parentThreadId, {
      runId: parentRunId,
      threadId: parentThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: parentController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  assert.deepEqual(
    store.tryStartRun(childThreadId, {
      runId: childRunId,
      threadId: childThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: childController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
      parentRunId,
    }),
    { ok: true },
  );

  assert.equal(store.abortRun(childRunId), false);
  assert.equal(childController.signal.aborted, false);

  assert.equal(store.abortRun(parentRunId), true);
  assert.equal(parentController.signal.aborted, true);
  assert.equal(childController.signal.aborted, false);

  store.finishRun(childThreadId, childRunId);
  store.finishRun(parentThreadId, parentRunId);
});

void test('abortTrackedRun can cancel a child run by stable child handle', () => {
  const store = createActiveRunStore();
  const parentThreadId = testThreadId(21);
  const childThreadId = testThreadId(22);
  const parentRunId = testRunId('parent-abort-child');
  const childRunId = testRunId('child-abort-child');
  const parentController = new AbortController();
  const childController = new AbortController();

  assert.deepEqual(
    store.tryStartRun(parentThreadId, {
      runId: parentRunId,
      threadId: parentThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: parentController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    store.tryStartRun(childThreadId, {
      runId: childRunId,
      threadId: childThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: childController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );

  assert.equal(store.abortTrackedRun(childRunId), true);
  assert.equal(childController.signal.aborted, true);
  assert.equal(parentController.signal.aborted, false);

  store.finishRun(childThreadId, childRunId);
  store.finishRun(parentThreadId, parentRunId);
});

void test('abortThreadTree aborts foreground and background runs owned by the same thread tree', () => {
  const store = createActiveRunStore();
  const parentThreadId = testThreadId(3);
  const childThreadId = testThreadId(4);
  const parentRunId = testRunId('parent-tree');
  const childRunId = testRunId('child-tree');
  const parentController = new AbortController();
  const childController = new AbortController();

  assert.deepEqual(
    store.tryStartRun(parentThreadId, {
      runId: parentRunId,
      threadId: parentThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: parentController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  assert.deepEqual(
    store.tryStartRun(childThreadId, {
      runId: childRunId,
      threadId: childThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: childController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );

  assert.equal(store.abortThreadTree(parentThreadId), true);
  assert.equal(parentController.signal.aborted, true);
  assert.equal(childController.signal.aborted, true);

  store.finishRun(childThreadId, childRunId);
  store.finishRun(parentThreadId, parentRunId);
});

void test('abortThreadTree ignores finished runs and clears owner index on cleanup', () => {
  const store = createActiveRunStore();
  const parentThreadId = testThreadId(5);
  const childThreadId = testThreadId(6);
  const parentRunId = testRunId('parent-cleanup');
  const childRunId = testRunId('child-cleanup');
  const parentController = new AbortController();
  const childController = new AbortController();

  assert.deepEqual(
    store.tryStartRun(parentThreadId, {
      runId: parentRunId,
      threadId: parentThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: parentController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  assert.deepEqual(
    store.tryStartRun(childThreadId, {
      runId: childRunId,
      threadId: childThreadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: parentThreadId,
      abortController: childController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );

  store.finishRun(childThreadId, childRunId);

  assert.equal(store.abortThreadTree(parentThreadId), true);
  assert.equal(parentController.signal.aborted, true);
  assert.equal(childController.signal.aborted, false);

  store.finishRun(parentThreadId, parentRunId);
  assert.equal(store.abortThreadTree(parentThreadId), false);
});

void test('getRunById exposes aborted state without leaking the abort controller', () => {
  const store = createActiveRunStore();
  const threadId = testThreadId(7);
  const runId = testRunId('snapshot');
  const abortController = new AbortController();

  assert.deepEqual(
    store.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  const before = store.getRunById(runId);
  assert.ok(before);
  assert.equal(before.aborted, false);
  assert.equal('abortController' in before, false);

  assert.equal(store.abortRun(runId), true);

  const after = store.getRunById(runId);
  assert.ok(after);
  assert.equal(after.aborted, true);
  assert.equal('abortController' in after, false);

  store.finishRun(threadId, runId);
});

void test('appendPendingInterject pushes to the live run and reports seq and depth', () => {
  const store = createActiveRunStore();
  const threadId = testThreadId(9);
  const runId = testRunId('append-interject');
  const interject = createRunInterjectBuffer();

  assert.deepEqual(
    store.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController: new AbortController(),
      interject,
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  assert.deepEqual(store.appendPendingInterject(runId, { text: 'a' }), {
    ok: true,
    receivedSeq: 1,
    bufferDepth: 1,
  });
  assert.deepEqual(store.appendPendingInterject(runId, { text: 'b' }), {
    ok: true,
    receivedSeq: 2,
    bufferDepth: 2,
  });
  assert.deepEqual(
    interject.items.map((item) => item.text),
    ['a', 'b'],
  );

  const snapshot = store.getRunById(runId);
  assert.ok(snapshot);
  assert.equal('interject' in snapshot, false);

  store.finishRun(threadId, runId);
});

void test('appendPendingInterject returns not_found for unknown or aborted runs', () => {
  const store = createActiveRunStore();
  const threadId = testThreadId(10);
  const runId = testRunId('append-interject-aborted');
  const abortController = new AbortController();

  assert.deepEqual(
    store.appendPendingInterject(testRunId('append-interject-missing'), {
      text: 'a',
    }),
    { ok: false, code: 'not_found' },
  );
  assert.deepEqual(
    store.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  abortController.abort();

  assert.deepEqual(store.appendPendingInterject(runId, { text: 'a' }), {
    ok: false,
    code: 'not_found',
  });

  store.finishRun(threadId, runId);
});

void test('appendPendingInterject rejects admission after the loop commits terminal', () => {
  const store = createActiveRunStore();
  const threadId = testThreadId(32);
  const runId = testRunId('append-interject-terminal');
  const interject = createRunInterjectBuffer();
  store.tryStartRun(threadId, {
    runId,
    threadId,
    stateRoot: '/tmp/home-state',
    workingDirectory: 'stories',
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-24T00:00:00.000Z',
  });

  closeInterjectBuffer(interject);

  assert.deepEqual(store.appendPendingInterject(runId, { text: 'too late' }), {
    ok: false,
    code: 'not_found',
  });
  store.finishRun(threadId, runId);
});

void test('finishRun ignores missing run ids instead of deleting the current thread run', () => {
  const store = createActiveRunStore();
  const threadId = testThreadId(8);
  const currentRunId = testRunId('current');
  const missingRunId = testRunId('missing');
  const abortController = new AbortController();

  assert.deepEqual(
    store.tryStartRun(threadId, {
      runId: currentRunId,
      threadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  store.finishRun(threadId, missingRunId);

  const activeRun = store.getRunByThreadId(threadId);
  assert.ok(activeRun);
  assert.equal(activeRun.runId, currentRunId);

  store.finishRun(threadId, currentRunId);
});

void test('requestPendingInterjectFlush marks a queued live run and reports empty queues', () => {
  const store = createActiveRunStore();
  const threadId = testThreadId(31);
  const runId = testRunId('flush-interject');
  const interject = createRunInterjectBuffer();

  assert.deepEqual(
    store.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController: new AbortController(),
      interject,
      startedAt: '2026-03-24T00:00:00.000Z',
    }),
    { ok: true },
  );

  assert.deepEqual(store.requestPendingInterjectFlush(runId), {
    ok: true,
    flushed: false,
  });

  store.appendPendingInterject(runId, { text: 'a' });
  assert.deepEqual(store.requestPendingInterjectFlush(runId), {
    ok: true,
    flushed: true,
  });
  assert.equal(interject.flushRequested, true);

  assert.deepEqual(
    store.requestPendingInterjectFlush(testRunId('flush-interject-missing')),
    { ok: false, code: 'not_found' },
  );

  store.finishRun(threadId, runId);
});
