import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDetachedSegment as makeSegment } from '../../../../test-support/ptc-execute-code-cell-process.js';
import {
  makeCellIdFactory,
  makeTerminalResult,
  makeTrackedDetachedHandle as makeHandle,
  TEST_EXECUTE_CODE_CELL_REGISTRY_THREAD_ID as THREAD_ID,
} from '../../../../test-support/ptc-execute-code-cell-registry.js';

import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import type { PtcExecuteCodeCellId } from './execute-code-runtime-contract.js';

void test('execute_code cell registry uses admitting sentinel to block duplicate admission', () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_admitting'),
    now: () => 1_000,
  });

  const first = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(first, { ok: true, cellId: 'ptc_cell_admitting_1' });

  const second = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(second, {
    ok: false,
    reasonCode: 'cell_active',
    cellId: 'ptc_cell_admitting_1',
    state: 'admitting',
  });

  const released = registry.releaseAdmittingCell({
    threadId: THREAD_ID,
    cellId: 'ptc_cell_admitting_1',
  });
  assert.deepEqual(released, { ok: true, value: { released: true } });

  const retry = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(retry, { ok: true, cellId: 'ptc_cell_admitting_2' });
});

void test('execute_code cell registry prunes idle thread revision metadata', () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_revision'),
  });

  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(admitted, { ok: true, cellId: 'ptc_cell_revision_1' });
  const activeRevision = registry.getThreadRevision({ threadId: THREAD_ID });
  assert.equal(activeRevision > 0, true);

  assert.deepEqual(
    registry.releaseAdmittingCell({
      threadId: THREAD_ID,
      cellId: 'ptc_cell_revision_1',
    }),
    { ok: true, value: { released: true } },
  );
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);
  assert.equal(registry.getThreadRevision({ threadId: THREAD_ID }), 0);
});

void test('execute_code cell registry drains running output without closing the cell', () => {
  const handle = makeHandle({
    output: makeSegment({ stdout: 'partial\n' }),
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_drain'),
  });
  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  registry.promoteAdmittedCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle,
      closeBridge: () => {
        throw new Error('draining output must not close the bridge');
      },
      taintSession: () => {
        throw new Error('draining output must not taint the session');
      },
    },
  });

  assert.deepEqual(
    registry.drainRunningCellOutput({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: makeSegment({ stdout: 'partial\n' }),
    },
  );
  assert.equal(handle.terminatedCount(), 0);
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'running',
  });
});

void test('execute_code cell registry does not expose cells across thread keys', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_thread'),
  });
  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }

  assert.deepEqual(
    registry.readTerminalCellResult({
      threadId: 'other-thread',
      cellId: admitted.cellId,
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.deepEqual(
    await registry.closeCell({
      threadId: 'other-thread',
      cellId: admitted.cellId,
      reason: 'terminate',
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'admitting',
  });
});

void test('execute_code cell registry tracks concurrent same-thread cells by exact cell id', () => {
  const registry = createPtcExecuteCodeCellRegistry({
    allowConcurrentCells: true,
    createCellId: makeCellIdFactory('ptc_cell_concurrent'),
  });
  const first = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  const second = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(first, {
    ok: true,
    cellId: 'ptc_cell_concurrent_1',
  });
  assert.deepEqual(second, {
    ok: true,
    cellId: 'ptc_cell_concurrent_2',
  });
  if (!first.ok || !second.ok) {
    return;
  }

  assert.deepEqual(
    registry.readCellState({ threadId: THREAD_ID, cellId: first.cellId }),
    { cellId: first.cellId, state: 'admitting' },
  );
  assert.deepEqual(
    registry.readCellState({ threadId: THREAD_ID, cellId: second.cellId }),
    { cellId: second.cellId, state: 'admitting' },
  );
  registry.releaseAdmittingCell({
    threadId: THREAD_ID,
    cellId: first.cellId,
  });
  assert.equal(
    registry.readCellState({ threadId: THREAD_ID, cellId: first.cellId }),
    null,
  );
  assert.deepEqual(
    registry.readCellState({ threadId: THREAD_ID, cellId: second.cellId }),
    { cellId: second.cellId, state: 'admitting' },
  );
});

void test('execute_code cell registry rejects invalid reap and retention configuration', () => {
  for (const terminalResultMemoryRetentionMs of [0, -1, 1.5]) {
    assert.throws(
      () =>
        createPtcExecuteCodeCellRegistry({
          terminalResultMemoryRetentionMs,
        }),
      /terminal result memory retention is invalid/u,
    );
  }
  for (const runningCellReapAfterMs of [0, -1, 1.5]) {
    assert.throws(
      () => createPtcExecuteCodeCellRegistry({ runningCellReapAfterMs }),
      /running cell reap policy is invalid/u,
    );
  }
});

void test('execute_code cell registry wakes and aborts global and thread revision waiters', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_wait_revision'),
  });

  assert.equal(registry.getRevision(), 0);
  const globalChange = registry.waitForRevisionChange(0);
  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  assert.equal(await globalChange, 1);
  assert.equal(await registry.waitForRevisionChange(0), 1);

  const globalAbortController = new AbortController();
  const globalAbort = registry.waitForRevisionChange(
    registry.getRevision(),
    globalAbortController.signal,
  );
  globalAbortController.abort();
  await assert.rejects(globalAbort, /cell wait aborted/u);

  const preAbortedGlobalController = new AbortController();
  preAbortedGlobalController.abort();
  await assert.rejects(
    registry.waitForRevisionChange(
      registry.getRevision(),
      preAbortedGlobalController.signal,
    ),
    /cell wait aborted/u,
  );

  const otherThreadId = `${THREAD_ID}-other`;
  const threadChange = registry.waitForThreadRevisionChange({
    threadId: otherThreadId,
    afterRevision: 0,
  });
  registry.reserveAdmittingCell({ threadId: otherThreadId });
  assert.equal(await threadChange, 1);
  assert.equal(
    await registry.waitForThreadRevisionChange({
      threadId: otherThreadId,
      afterRevision: 0,
    }),
    1,
  );

  const threadAbortController = new AbortController();
  const threadAbort = registry.waitForThreadRevisionChange({
    threadId: `${THREAD_ID}-idle`,
    afterRevision: 0,
    abortSignal: threadAbortController.signal,
  });
  threadAbortController.abort();
  await assert.rejects(threadAbort, /cell thread wait aborted/u);

  const preAbortedThreadController = new AbortController();
  preAbortedThreadController.abort();
  await assert.rejects(
    registry.waitForThreadRevisionChange({
      threadId: `${THREAD_ID}-pre-aborted`,
      afterRevision: 0,
      abortSignal: preAbortedThreadController.signal,
    }),
    /cell thread wait aborted/u,
  );
});

void test('execute_code cell registry exposes running metadata and aborts fallback output waits', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_running_metadata'),
  });
  const missing = {
    threadId: THREAD_ID,
    cellId: 'ptc_cell_missing' as PtcExecuteCodeCellId,
  };
  assert.deepEqual(registry.drainRunningCellOutput(missing), {
    ok: false,
    reasonCode: 'cell_missing',
  });
  assert.deepEqual(registry.readRunningCellOutputRevision(missing), {
    ok: false,
    reasonCode: 'cell_missing',
  });
  assert.deepEqual(registry.readRunningCellEffectiveTimeoutMs(missing), {
    ok: false,
    reasonCode: 'cell_missing',
  });
  assert.deepEqual(
    registry.markRunningCellTerminalResultPersistence({
      ...missing,
      stateRoot: '/tmp/geulbat-ptc-missing-state',
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.deepEqual(
    await registry.recordTerminalCellResult({
      ...missing,
      result: makeTerminalResult({ stdout: 'missing\n' }),
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.equal(
    await registry.waitForRunningCellOutputChange({
      ...missing,
      afterOutputRevision: 4,
    }),
    5,
  );

  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  assert.deepEqual(
    await registry.recordTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      result: makeTerminalResult({ stdout: 'not-running\n' }),
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  const output = makeSegment({ stdout: 'incremental output\n' });
  registry.promoteAdmittedCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 12_345,
      handle: makeHandle({ output }),
      closeBridge: () => {},
      taintSession: () => true,
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });
  assert.deepEqual(
    registry.markAdmittedCellQueued({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
      cancelAcquire: () => {},
      settlePromise: Promise.resolve(),
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.deepEqual(
    registry.promoteAdmittedCell({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      resources: {
        effectiveTimeoutMs: 60_000,
        handle: makeHandle({ output: makeSegment() }),
        closeBridge: () => {},
        taintSession: () => true,
      },
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.deepEqual(
    await registry.recordCellStartFailure({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      failure: {
        ok: false,
        reasonCode: 'ptc_execute_code_lab_admission_failed',
        message: 'running cells cannot become start failures',
      },
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );

  assert.deepEqual(
    registry.drainRunningCellOutput({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: output },
  );
  assert.deepEqual(
    registry.readRunningCellOutputRevision({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: { outputRevision: 0 } },
  );
  assert.deepEqual(
    registry.readRunningCellEffectiveTimeoutMs({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: { effectiveTimeoutMs: 12_345 } },
  );
  assert.deepEqual(
    registry.releaseAdmittingCell({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: { released: false } },
  );
  assert.deepEqual(
    registry.markRunningCellTerminalResultPersistence({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      stateRoot: '/tmp/geulbat-ptc-test-state-2',
    }),
    { ok: true, value: { marked: true } },
  );

  const outputAbortController = new AbortController();
  const outputAbort = registry.waitForRunningCellOutputChange({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    afterOutputRevision: 0,
    abortSignal: outputAbortController.signal,
  });
  outputAbortController.abort();
  await assert.rejects(outputAbort, /cell output wait aborted/u);

  const preAbortedOutputController = new AbortController();
  preAbortedOutputController.abort();
  await assert.rejects(
    registry.waitForRunningCellOutputChange({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      afterOutputRevision: 0,
      abortSignal: preAbortedOutputController.signal,
    }),
    /cell output wait aborted/u,
  );

  const terminalResult = makeTerminalResult({ stdout: 'finished\n' });
  assert.deepEqual(
    await registry.recordCellCleanupFailure({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      message: 'cleanup owner failed',
      diagnostics: { cleanupOwner: 'session' },
      terminalResult,
    }),
    { ok: true, value: { retained: true } },
  );
  assert.deepEqual(
    await registry.recordCellCleanupFailure({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      message: 'cleanup retry failed',
      diagnostics: { cleanupAttempt: 2 },
    }),
    { ok: true, value: { retained: true } },
  );
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: {
        status: 'cleanup_failed',
        message: 'cleanup retry failed',
        diagnostics: { cleanupAttempt: 2 },
        terminalResult,
      },
    },
  );
});
