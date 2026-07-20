import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from './execute-code-cell-process.js';

import {
  createPtcExecuteCodeCellRegistry,
  PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
} from './execute-code-cell-registry.js';
import type {
  PtcExecuteCodeCellDurableOutput,
  PtcExecuteCodeCellId,
} from './execute-code-runtime-contract.js';

const THREAD_ID = 'thread-ptc-cell-registry';

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
    reasonCode: 'cell_result_unclaimed',
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });

  releasePersistence();
  assert.deepEqual(await recording, {
    ok: true,
    value: { bridgeClosed: true },
  });
});

void test('execute_code cell registry lets termination own a stale terminal recorder race', async () => {
  let firstBridgeCall!: () => void;
  let secondBridgeCall!: () => void;
  let releaseBridge!: () => void;
  const firstBridgeCalled = new Promise<void>((resolve) => {
    firstBridgeCall = resolve;
  });
  const secondBridgeCalled = new Promise<void>((resolve) => {
    secondBridgeCall = resolve;
  });
  const bridgeReleased = new Promise<void>((resolve) => {
    releaseBridge = resolve;
  });
  let bridgeCloseCalls = 0;
  const handle = makeHandle({
    output: makeSegment({ stdout: 'terminated output\n' }),
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
  });
  const taintReasons: string[] = [];
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_terminal_race'),
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
        bridgeCloseCalls += 1;
        if (bridgeCloseCalls === 1) {
          firstBridgeCall();
        } else if (bridgeCloseCalls === 2) {
          secondBridgeCall();
        }
        return bridgeReleased;
      },
      taintSession: ({ reason }) => {
        taintReasons.push(reason);
        return true;
      },
    },
  });

  const staleTerminalRecorder = registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: makeTerminalResult({ stdout: 'natural terminal output\n' }),
  });
  await firstBridgeCalled;

  const terminate = registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'terminate',
  });
  await secondBridgeCalled;
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminating',
  });

  releaseBridge();

  assert.deepEqual(await staleTerminalRecorder, {
    ok: false,
    reasonCode: 'cell_missing',
  });
  assert.deepEqual(await terminate, {
    ok: true,
    status: 'terminated',
    output: makeSegment({ stdout: 'terminated output\n' }),
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
    bridgeClosed: true,
    sessionTainted: true,
  });
  assert.equal(handle.terminatedCount(), 1);
  assert.deepEqual(taintReasons, ['terminate']);
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);
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

void test('execute_code cell registry keeps retained terminal result when orphan reaper arrives late', async () => {
  const handle = makeHandle({ output: makeSegment({ stdout: 'unused' }) });
  let bridgeClosed = 0;
  let tainted = 0;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_drop'),
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
        bridgeClosed += 1;
      },
      taintSession: () => {
        tainted += 1;
        return true;
      },
    },
  });
  const terminalResult = makeTerminalResult({ stdout: 'finished\n' });
  await registry.recordTerminalCellResult({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    result: terminalResult,
  });

  const kept = await registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'orphan_reap',
  });

  assert.deepEqual(kept, {
    ok: true,
    status: 'terminal_retained_kept',
    terminalResult,
  });
  assert.equal(handle.terminatedCount(), 0);
  assert.equal(bridgeClosed, 1);
  assert.equal(tainted, 0);
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: terminalResult },
  );
});

void test('execute_code cell registry retains terminal output recorded while orphan reaper is terminating the cell', async () => {
  const exit = createDeferred<DetachedProcessExitInfo>();
  const handle = makeHandle({
    output: makeSegment(),
    exit: exit.promise,
  });
  const taintReasons: string[] = [];
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_orphan_terminal_race'),
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
      taintSession: ({ reason }) => {
        taintReasons.push(reason);
        return true;
      },
    },
  });

  const reaping = registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'orphan_reap',
  });
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminating',
  });

  const terminalResult = makeTerminalResult({ stdout: 'natural output\n' });
  assert.deepEqual(
    await registry.recordTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      result: terminalResult,
    }),
    { ok: true, value: { bridgeClosed: true } },
  );

  exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });

  assert.deepEqual(await reaping, {
    ok: true,
    status: 'terminated',
    output: makeSegment(),
    exit: { kind: 'exit', exitCode: 0, processTerminated: true },
    bridgeClosed: true,
    sessionTainted: true,
  });
  assert.deepEqual(taintReasons, ['orphan_reap']);
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { ok: true, value: terminalResult },
  );
});

void test('execute_code cell registry terminates running cell once and taints session', async () => {
  const output = makeSegment({ stdout: 'partial\n', stderr: 'err\n' });
  const handle = makeHandle({
    output,
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
  });
  const calls: string[] = [];
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_running'),
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
        calls.push('bridge');
      },
      taintSession: ({ reason }) => {
        calls.push(`taint:${reason}`);
        return true;
      },
    },
  });

  const closed = await registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'terminate',
  });
  assert.deepEqual(closed, {
    ok: true,
    status: 'terminated',
    output,
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
    bridgeClosed: true,
    sessionTainted: true,
  });
  assert.equal(handle.terminatedCount(), 1);
  assert.deepEqual(handle.terminateGraceMsValues(), [
    PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
  ]);
  assert.deepEqual(calls, ['bridge', 'taint:terminate']);
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);

  const secondClose = await registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'terminate',
  });
  assert.deepEqual(secondClose, { ok: false, reasonCode: 'cell_missing' });
  assert.equal(handle.terminatedCount(), 1);
  assert.deepEqual(handle.terminateGraceMsValues(), [
    PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
  ]);
});

void test('execute_code cell registry releases ownership when taint close is not proven', async () => {
  const handle = makeHandle({
    output: makeSegment({ stdout: 'unsafe\n' }),
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_taint_fail'),
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
      taintSession: () => false,
    },
  });

  const closed = await registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'terminate',
  });

  assert.deepEqual(closed, {
    ok: true,
    status: 'terminated',
    output: makeSegment({ stdout: 'unsafe\n' }),
    exit: { kind: 'signal', exitCode: null, processTerminated: false },
    bridgeClosed: true,
    sessionTainted: false,
    cleanupDiagnostics: {
      sessionCloseFailed: true,
      sessionTainted: true,
    },
  });
  assert.equal(registry.readCellState({ threadId: THREAD_ID }), null);
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: true,
    cellId: 'ptc_cell_taint_fail_2',
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

void test('execute_code cell registry reaps running cells through explicit owner policy', async () => {
  const timerHandle = { id: 'orphan-reap-timer' };
  let scheduled:
    | { callback: () => Promise<void>; delayMs: number; timer: unknown }
    | undefined;
  const clearedTimers: unknown[] = [];
  const handle = makeHandle({
    output: makeSegment({ stdout: 'orphan output\n' }),
  });
  const taintReasons: string[] = [];
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_reap'),
    runningCellReapAfterMs: 25,
    scheduleReapTimeout: (callback, delayMs) => {
      scheduled = { callback, delayMs, timer: timerHandle };
      return () => {
        clearedTimers.push(timerHandle);
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
      handle,
      closeBridge: () => {},
      taintSession: ({ reason }) => {
        taintReasons.push(reason);
        return true;
      },
    },
  });

  assert.equal(scheduled?.delayMs, 25);
  await scheduled?.callback();

  assert.equal(handle.terminatedCount(), 1);
  assert.deepEqual(handle.terminateGraceMsValues(), [
    PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
  ]);
  assert.deepEqual(taintReasons, ['orphan_reap']);
  assert.deepEqual(clearedTimers, [timerHandle]);
  assert.deepEqual(registry.readCellState({ threadId: THREAD_ID }), {
    cellId: admitted.cellId,
    state: 'terminal_retained',
  });
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: {
        status: 'terminated',
        output: makeSegment({ stdout: 'orphan output\n' }),
        exit: { kind: 'exit', exitCode: 0, processTerminated: true },
      },
    },
  );
});

void test('execute_code cell registry closes all cell states through the single close path', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_close_all'),
  });
  const admitting = registry.reserveAdmittingCell({
    threadId: `${THREAD_ID}-admitting`,
  });
  const completed = registry.reserveAdmittingCell({
    threadId: `${THREAD_ID}-completed`,
  });
  const running = registry.reserveAdmittingCell({
    threadId: `${THREAD_ID}-running`,
  });
  assert.equal(admitting.ok, true);
  assert.equal(completed.ok, true);
  assert.equal(running.ok, true);
  if (!admitting.ok || !completed.ok || !running.ok) {
    return;
  }

  let completedTaintCount = 0;
  const completedHandle = makeHandle({ output: makeSegment() });
  registry.promoteAdmittedCell({
    threadId: `${THREAD_ID}-completed`,
    cellId: completed.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: completedHandle,
      closeBridge: () => {},
      taintSession: () => {
        completedTaintCount += 1;
        return true;
      },
    },
  });
  await registry.recordTerminalCellResult({
    threadId: `${THREAD_ID}-completed`,
    cellId: completed.cellId,
    result: makeTerminalResult({ stdout: 'done\n' }),
  });

  const runningHandle = makeHandle({ output: makeSegment({ stdout: 'live' }) });
  const taintReasons: string[] = [];
  registry.promoteAdmittedCell({
    threadId: `${THREAD_ID}-running`,
    cellId: running.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: runningHandle,
      closeBridge: () => {},
      taintSession: ({ reason }) => {
        taintReasons.push(reason);
        return true;
      },
    },
  });

  const closed = await registry.closeAllCells({ reason: 'shutdown' });

  assert.deepEqual(closed, { closedCount: 3 });
  assert.equal(completedHandle.terminatedCount(), 0);
  assert.equal(completedTaintCount, 0);
  assert.equal(runningHandle.terminatedCount(), 1);
  assert.deepEqual(taintReasons, ['shutdown']);
  assert.equal(
    registry.readCellState({ threadId: `${THREAD_ID}-admitting` }),
    null,
  );
  assert.equal(
    registry.readCellState({ threadId: `${THREAD_ID}-completed` }),
    null,
  );
  assert.equal(
    registry.readCellState({ threadId: `${THREAD_ID}-running` }),
    null,
  );
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

void test('execute_code queued cell cancellation owns no running resource and finalizes only its store', async () => {
  const settle = createDeferred<void>();
  let cancelCount = 0;
  let finalizedCount = 0;
  const registry = createPtcExecuteCodeCellRegistry({
    allowConcurrentCells: true,
    createCellId: makeCellIdFactory('ptc_cell_queued'),
  });
  const admitted = registry.reserveAdmittingCell({ threadId: THREAD_ID });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  assert.deepEqual(
    registry.markAdmittedCellQueued({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
      cancelAcquire: () => {
        cancelCount += 1;
        settle.resolve();
      },
      settlePromise: settle.promise,
      finalizeStore: async () => {
        finalizedCount += 1;
        return { store: { discardedWrites: 2 } };
      },
    }),
    { ok: true, value: { state: 'queued' } },
  );
  assert.deepEqual(
    registry.readCellState({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    { cellId: admitted.cellId, state: 'queued' },
  );

  assert.deepEqual(
    await registry.closeCell({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
      reason: 'terminate',
    }),
    {
      ok: true,
      status: 'queued_cancelled',
      store: { discardedWrites: 2 },
    },
  );
  assert.equal(cancelCount, 1);
  assert.equal(finalizedCount, 1);
  assert.equal(
    registry.readCellState({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    null,
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

void test('execute_code orphan reaping retains sanitized cleanup diagnostics', async () => {
  const cancelledTimers: string[] = [];
  const bridgeError = Object.assign(new Error('bridge close failed'), {
    name: 'BridgeFailure',
    code: 7,
  });
  const placementError = Object.assign(new Error('placement close failed'), {
    name: 'invalid name',
    code: 'E_PLACE',
  });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_orphan_cleanup'),
    runningCellReapAfterMs: 25,
    scheduleReapTimeout: () => () => {
      cancelledTimers.push('cancelled');
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
      handle: makeHandle({
        output: makeSegment({ stderr: 'partial error\n' }),
      }),
      closeBridge: () => {
        throw bridgeError;
      },
      taintSession: () => {
        throw { code: 'unsafe code' };
      },
      finalizePlacement: () => {
        throw placementError;
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  const closed = await registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'orphan_reap',
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.status, 'terminated');
  assert.deepEqual(cancelledTimers, ['cancelled']);
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: {
        status: 'cleanup_failed',
        message: 'PTC execute_code cell orphan reaper cleanup failed',
        diagnostics: {
          callbackBridgeCloseFailed: true,
          callbackBridgeCloseErrorName: 'BridgeFailure',
          callbackBridgeCloseErrorCode: 7,
          sessionCloseFailed: true,
          sessionTainted: true,
          sessionTaintErrorName: 'NonErrorThrown',
          placementReleaseFailed: true,
          placementReleaseErrorName: 'Error',
          placementReleaseErrorCode: 'E_PLACE',
        },
        terminalResult: {
          status: 'terminated',
          output: makeSegment({ stderr: 'partial error\n' }),
          exit: { kind: 'exit', exitCode: 0, processTerminated: true },
        },
      },
    },
  );
});

function makeCellIdFactory(prefix: string): () => PtcExecuteCodeCellId {
  let next = 0;
  return () => `${prefix}_${(next += 1)}` as PtcExecuteCodeCellId;
}

function makeSegment(
  args: Partial<DetachedProcessOutputSegment> = {},
): DetachedProcessOutputSegment {
  return {
    stdout: args.stdout ?? '',
    stderr: args.stderr ?? '',
  };
}

function makeTerminalResult(args: {
  stdout: string;
  stderr?: string;
  exit?: DetachedProcessExitInfo;
}): {
  status: 'completed';
  output: DetachedProcessOutputSegment;
  exit: DetachedProcessExitInfo;
} {
  return {
    status: 'completed',
    output: makeSegment({
      stdout: args.stdout,
      ...(args.stderr !== undefined ? { stderr: args.stderr } : {}),
    }),
    exit: args.exit ?? { kind: 'exit', exitCode: 0, processTerminated: true },
  };
}

function makeHandle(args: {
  output: DetachedProcessOutputSegment;
  exit?: DetachedProcessExitInfo | Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle & {
  terminatedCount(): number;
  terminateGraceMsValues(): number[];
} {
  let terminated = 0;
  const terminateGraceMsValues: number[] = [];
  return {
    drainNewOutput: () => args.output,
    exit: Promise.resolve(
      args.exit ?? { kind: 'exit', exitCode: 0, processTerminated: true },
    ),
    terminate: ({ graceMs }) => {
      terminated += 1;
      terminateGraceMsValues.push(graceMs);
    },
    terminatedCount: () => terminated,
    terminateGraceMsValues: () => [...terminateGraceMsValues],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
