import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deferredTestValue as createDeferred,
  makeDetachedSegment as makeSegment,
} from '../../../../test-support/ptc-execute-code-cell-process.js';
import {
  makeCellIdFactory,
  makeTerminalResult,
  makeTrackedDetachedHandle as makeHandle,
  TEST_EXECUTE_CODE_CELL_REGISTRY_THREAD_ID as THREAD_ID,
} from '../../../../test-support/ptc-execute-code-cell-registry.js';

import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import type {
  PtcExecuteCodeCellDurableOutput,
  PtcExecuteCodeCellId,
} from './execute-code-runtime-contract.js';

function makeDurableOutput(
  cellId: PtcExecuteCodeCellId,
): PtcExecuteCodeCellDurableOutput {
  return {
    outputRef: `tool-output://ptc-test/${cellId}`,
    fullOutputBytes: 1,
    fullOutputChars: 1,
    status: 'completed',
    exitCode: 0,
  };
}

void test('execute_code cell registry blocks new admission until retained terminal output is claimed', async () => {
  const bridgeCalls: string[] = [];
  const handle = makeHandle({
    output: makeSegment({ stdout: 'unused-after-natural-exit' }),
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_complete'),
    now: () => 2_000,
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
        bridgeCalls.push('close');
      },
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
    },
  });

  const terminalResult = makeTerminalResult({
    stdout: 'done\n',
    exit: { kind: 'exit', exitCode: 0, processTerminated: true },
  });
  const recorded = await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: terminalResult,
  });
  assert.deepEqual(recorded, { ok: true, value: { bridgeClosed: true } });
  assert.deepEqual(bridgeCalls, ['close']);
  assert.equal(handle.terminatedCount(), 0);
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });
  const nextAdmission = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(nextAdmission, {
    ok: false,
    reasonCode: 'cell_result_unclaimed',
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });

  const firstRead = registry.readTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
  });
  assert.deepEqual(firstRead, { ok: true, value: terminalResult });
  const retryRead = registry.readTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
  });
  assert.deepEqual(retryRead, { ok: true, value: terminalResult });
  const claimed = registry.takeTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
  });
  assert.deepEqual(claimed, { ok: true, value: terminalResult });
  const retry = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(retry, {
    ok: true,
    cellId: 'ptc_cell_complete_2',
  });
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: 'ptc_cell_complete_2',
    state: 'admitting',
  });
});

void test('execute_code cell registry blocks admission while durable terminal handoff is in flight', async () => {
  let markPersistenceStarted!: () => void;
  let releasePersistence!: () => void;
  const persistenceStarted = new Promise<void>((resolve) => {
    markPersistenceStarted = resolve;
  });
  const persistenceReleased = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_persistence_in_flight'),
    persistTerminalResult: async ({ cellId }) => {
      markPersistenceStarted();
      await persistenceReleased;
      return makeDurableOutput(cellId);
    },
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
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {},
      taintSession: () => true,
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  const recording = registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: makeTerminalResult({ stdout: 'handoff in flight\n' }),
  });
  await persistenceStarted;

  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: false,
    reasonCode: 'cell_active',
    cellId: admitted.cellId,
    state: 'running',
  });

  releasePersistence();
  assert.deepEqual(await recording, {
    ok: true,
    value: { bridgeClosed: true },
  });
});

void test('execute_code cell registry retains terminal cleanup failure until claimed', async () => {
  const handle = makeHandle({
    output: makeSegment({ stdout: 'unused-after-cleanup-failure' }),
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_cleanup_failure'),
    now: () => 3_000,
  });
  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  let taintCount = 0;
  registry.promoteAdmittedCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle,
      closeBridge: () => {
        throw Object.assign(new Error('bridge close failed at /private/path'), {
          code: 'EPIPE',
        });
      },
      taintSession: () => {
        taintCount += 1;
        return false;
      },
    },
  });

  const terminalResult = makeTerminalResult({ stdout: 'done\n' });
  const recorded = await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: terminalResult,
  });

  assert.deepEqual(recorded, {
    ok: true,
    value: { bridgeClosed: false, sessionTainted: false },
  });
  assert.equal(taintCount, 1);
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: false,
    reasonCode: 'cell_result_unclaimed',
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });

  const claimed = registry.takeTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
  });
  assert.deepEqual(claimed, {
    ok: true,
    value: {
      status: 'cleanup_failed',
      message: 'PTC execute_code cell cleanup failed after terminal exit',
      diagnostics: {
        callbackBridgeCloseFailed: true,
        callbackBridgeCloseErrorName: 'Error',
        callbackBridgeCloseErrorCode: 'EPIPE',
        sessionCloseFailed: true,
        sessionTainted: true,
      },
      terminalResult,
    },
  });
  assert.equal(JSON.stringify(claimed).includes('/private/path'), false);
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: true,
    cellId: 'ptc_cell_cleanup_failure_2',
  });
});

void test('execute_code cell registry expires retained terminal output without reporting it as missing', async () => {
  let now = 3_000;
  const handle = makeHandle({
    output: makeSegment({ stdout: 'unused-after-expiry' }),
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_expire'),
    now: () => now,
    terminalResultMemoryRetentionMs: 50,
    persistTerminalResult: async ({ cellId }) => makeDurableOutput(cellId),
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
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  const terminalResult = makeTerminalResult({
    stdout: 'short-lived result\n',
    exit: { kind: 'exit', exitCode: 0, processTerminated: true },
  });
  await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: terminalResult,
  });

  now = 3_049;
  assert.deepEqual(
    registry.readTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: terminalResult },
  );

  now = 3_050;
  assert.deepEqual(
    registry.readTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: false, reasonCode: 'cell_expired' },
  );
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: true,
    cellId: 'ptc_cell_expire_2',
  });
});

void test('execute_code cell registry keeps unclaimed terminal output when no durable handoff exists', async () => {
  let now = 3_500;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_no_durable_handoff'),
    now: () => now,
    terminalResultMemoryRetentionMs: 10,
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
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
    },
  });

  const terminalResult = makeTerminalResult({
    stdout: 'must remain claimable\n',
  });
  await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: terminalResult,
  });

  now = 3_510;
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: terminalResult },
  );
});

void test('execute_code cell registry prunes expired retained output during admission lookup', async () => {
  let now = 4_000;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_expire_admission'),
    now: () => now,
    terminalResultMemoryRetentionMs: 25,
    persistTerminalResult: async ({ cellId }) => makeDurableOutput(cellId),
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
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: makeTerminalResult({ stdout: 'expired-before-next-exec\n' }),
  });

  now = 4_025;
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: true,
    cellId: 'ptc_cell_expire_admission_2',
  });
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: 'ptc_cell_expire_admission_2',
    state: 'admitting',
  });
});

void test('execute_code cell registry prunes expired retained output during state lookup', async () => {
  let now = 5_000;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_expire_state'),
    now: () => now,
    terminalResultMemoryRetentionMs: 10,
    persistTerminalResult: async ({ cellId }) => makeDurableOutput(cellId),
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
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: makeTerminalResult({ stdout: 'expired-state\n' }),
  });

  now = 5_010;
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_expired',
  });
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: true,
    cellId: 'ptc_cell_expire_state_2',
  });
});

void test('execute_code cell registry retains cleanup failure when completion bridge close fails', async () => {
  const handle = makeHandle({ output: makeSegment({ stdout: 'finished\n' }) });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_bridge_fail'),
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
        throw Object.assign(new Error('bridge close failed at /secret/token'), {
          code: 'ECONNRESET',
        });
      },
      taintSession: () => true,
      finalizePlacement: async () => ({
        ok: false,
        message: 'placement cleanup also failed',
        diagnostics: { placementLane: 'warm' },
      }),
    },
  });

  const terminalResult = makeTerminalResult({ stdout: 'finished\n' });
  const recorded = await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: terminalResult,
  });

  assert.deepEqual(recorded, {
    ok: true,
    value: { bridgeClosed: false, sessionTainted: true },
  });
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });
  const claimed = registry.takeTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
  });
  assert.deepEqual(claimed, {
    ok: true,
    value: {
      status: 'cleanup_failed',
      message: 'PTC execute_code cell cleanup failed after terminal exit',
      diagnostics: {
        callbackBridgeCloseFailed: true,
        callbackBridgeCloseErrorName: 'Error',
        callbackBridgeCloseErrorCode: 'ECONNRESET',
        placementReleaseFailed: true,
        placementLane: 'warm',
      },
      terminalResult,
    },
  });
  assert.equal(JSON.stringify(claimed).includes('/secret/token'), false);
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);
});

void test('execute_code cell registry persists natural completion before deleting its restart coordinate', async () => {
  const persistence = createDeferred<void>();
  const persistenceStarted = createDeferred<void>();
  const calls: string[] = [];
  let persistenceCalls = 0;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_complete_linearized'),
    persistTerminalResult: async ({ cellId, result }) => {
      persistenceCalls += 1;
      calls.push(`persist:${result.status}`);
      if (persistenceCalls === 1) {
        persistenceStarted.resolve();
        await persistence.promise;
      }
      return makeDurableOutput(cellId);
    },
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
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {
        calls.push('bridge');
      },
      taintSession: () => true,
      finalizeCoordinate: () => {
        calls.push('coordinate');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  const recording = registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: makeTerminalResult({ stdout: 'completed durably\n' }),
  });
  await persistenceStarted.promise;
  assert.deepEqual(calls, ['bridge', 'persist:completed']);

  persistence.resolve();
  assert.equal((await recording).ok, true);
  assert.deepEqual(calls, [
    'bridge',
    'persist:completed',
    'coordinate',
    'persist:completed',
  ]);
});

void test('execute_code cell registry reaps retained terminal output on schedule without any access', async () => {
  let now = 6_000;
  const scheduled: Array<{
    callback: () => Promise<void> | void;
    delayMs: number;
  }> = [];
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_reap'),
    now: () => now,
    terminalResultMemoryRetentionMs: 50,
    persistTerminalResult: async ({ cellId }) => makeDurableOutput(cellId),
    scheduleReapTimeout: (callback, delayMs) => {
      const entry = { callback, delayMs };
      scheduled.push(entry);
      return () => {
        const index = scheduled.indexOf(entry);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      };
    },
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
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });
  await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: makeTerminalResult({ stdout: 'abandoned-result\n' }),
  });

  // A reap must be scheduled at the retention horizon (expiresAtMs - now = 50).
  const reap = scheduled.find((entry) => entry.delayMs === 50);
  assert.notEqual(reap, undefined);
  if (reap === undefined) {
    return;
  }

  // Fire the scheduled reap after expiry with NO prior read/admission access.
  now = 6_051;
  await reap.callback();

  // Reaped by the timer (cell_missing), not lazily expired by this read
  // (which would report cell_expired). Proves the record left memory on its own.
  assert.deepEqual(
    registry.readTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );
  // Coupled per-thread revision metadata is pruned by the reap as well.
  assert.equal(registry.getThreadRevision({ threadId: THREAD_ID }), 0);
});

void test('execute_code cell registry keeps a failed durable handoff cell-scoped during concurrent admission', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    allowConcurrentCells: true,
    createCellId: makeCellIdFactory('ptc_cell_concurrent_handoff_failure'),
    persistTerminalResult: async () => {
      throw new Error('simulated durable handoff failure');
    },
  });
  const first = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(first, {
    ok: true,
    cellId: 'ptc_cell_concurrent_handoff_failure_1',
  });
  if (!first.ok) {
    return;
  }
  registry.promoteAdmittedCell({
    threadId: THREAD_ID,
    cellId: first.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: makeHandle({ output: makeSegment() }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint session');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  const terminalResult = makeTerminalResult({
    stdout: 'retained after failed durable handoff\n',
  });
  await assert.rejects(
    registry.recordTerminalCellResult({
      threadId: THREAD_ID,
      cellId: first.cellId,
      result: terminalResult,
    }),
    /simulated durable handoff failure/,
  );
  assert.deepEqual(
    registry.readCellState({ threadId: THREAD_ID, cellId: first.cellId }),
    { cellId: first.cellId, state: 'terminal_retained' },
  );

  const second = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.deepEqual(second, {
    ok: true,
    cellId: 'ptc_cell_concurrent_handoff_failure_2',
  });
  if (!second.ok) {
    return;
  }
  assert.deepEqual(
    registry.readCellState({ threadId: THREAD_ID, cellId: second.cellId }),
    { cellId: second.cellId, state: 'admitting' },
  );
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: first.cellId,
    }),
    { ok: true, value: terminalResult },
  );
  assert.deepEqual(
    registry.readCellState({ threadId: THREAD_ID, cellId: second.cellId }),
    { cellId: second.cellId, state: 'admitting' },
  );
});

void test('execute_code cell retains placement cleanup failure before exposing terminal output', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_placement_cleanup'),
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
      handle: makeHandle({ output: makeSegment({ stdout: 'done\n' }) }),
      closeBridge: () => {},
      taintSession: () => true,
      finalizePlacement: async () => ({
        ok: false,
        message: 'cold cleanup failed',
        diagnostics: { placementLane: 'cold_burst' },
      }),
    },
  });

  const terminalResult = makeTerminalResult({ stdout: 'done\n' });
  assert.deepEqual(
    await registry.recordTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      result: terminalResult,
    }),
    { ok: true, value: { bridgeClosed: true } },
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
        message: 'cold cleanup failed',
        diagnostics: {
          placementReleaseFailed: true,
          placementLane: 'cold_burst',
        },
        terminalResult,
      },
    },
  );
});

void test('execute_code cell registry retains queued start failure with durable store evidence', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_start_failure'),
    persistTerminalResult: async ({ cellId }) => makeDurableOutput(cellId),
  });
  const missingFailure = {
    ok: false as const,
    reasonCode: 'ptc_execute_code_lab_admission_failed' as const,
    message: 'lab admission failed',
  };
  assert.deepEqual(
    await registry.recordCellStartFailure({
      threadId: THREAD_ID,
      cellId: 'ptc_cell_missing' as PtcExecuteCodeCellId,
      failure: missingFailure,
    }),
    { ok: false, reasonCode: 'cell_missing' },
  );

  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  registry.markAdmittedCellQueued({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    cancelAcquire: () => {},
    settlePromise: Promise.resolve(),
    finalizeStore: async () => ({ store: { discardedWrites: 3 } }),
  });
  assert.deepEqual(
    await registry.recordCellStartFailure({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      failure: missingFailure,
    }),
    { ok: true, value: { retained: true } },
  );
  const expectedFailure = {
    ...missingFailure,
    store: { discardedWrites: 3 },
  };
  assert.deepEqual(
    registry.readTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: { status: 'start_failed', failure: expectedFailure },
    },
  );
  assert.deepEqual(
    registry.readTerminalCellDurableOutput({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    makeDurableOutput(admitted.cellId),
  );
  assert.deepEqual(
    await registry.recordCellStartFailure({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      failure: missingFailure,
    }),
    { ok: true, value: { retained: true } },
  );
});
