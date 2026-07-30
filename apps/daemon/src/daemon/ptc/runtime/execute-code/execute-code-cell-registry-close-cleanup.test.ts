import test from 'node:test';
import assert from 'node:assert/strict';
import type { DetachedProcessExitInfo } from './execute-code-cell-process.js';
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

import {
  createPtcExecuteCodeCellRegistry,
  PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
} from './execute-code-cell-registry.js';
import type { PtcExecuteCodeCellRetainedResult } from './execute-code-cell-terminal-retention.js';

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
        output: makeSegment({ stdout: 'terminated output\n' }),
        exit: { kind: 'signal', exitCode: null, processTerminated: false },
      },
    },
  );
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
        output,
        exit: { kind: 'signal', exitCode: null, processTerminated: false },
      },
    },
  );
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

void test('execute_code cell registry persists explicit termination before deleting its restart coordinate', async () => {
  const persistence = createDeferred<void>();
  const persistenceStarted = createDeferred<void>();
  const calls: string[] = [];
  const output = makeSegment({ stdout: 'durable before coordinate delete\n' });
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_terminate_linearized'),
    persistTerminalResult: async ({ cellId, result }) => {
      calls.push(`persist:${result.status}`);
      persistenceStarted.resolve();
      await persistence.promise;
      return {
        outputRef: `tool-output://ptc-test/${cellId}`,
        fullOutputBytes: 32,
        fullOutputChars: 32,
        status: 'terminated',
        exitCode: null,
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
      handle: makeHandle({
        output,
        exit: { kind: 'signal', exitCode: null, processTerminated: false },
      }),
      closeBridge: () => {
        calls.push('bridge');
      },
      taintSession: () => {
        calls.push('taint');
        return true;
      },
      finalizeCoordinate: () => {
        calls.push('coordinate');
      },
      terminalResultStateRoot: '/tmp/geulbat-ptc-test-state',
    },
  });

  const closing = registry.closeCell({
    threadId: THREAD_ID,
    cellId: admitted.cellId,
    reason: 'terminate',
  });
  await persistenceStarted.promise;
  assert.deepEqual(calls, ['persist:terminated']);

  persistence.resolve();
  assert.equal((await closing).ok, true);
  assert.deepEqual(calls, [
    'persist:terminated',
    'bridge',
    'coordinate',
    'taint',
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
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: {
        status: 'cleanup_failed',
        message: 'PTC execute_code explicit termination cleanup failed',
        diagnostics: {
          sessionCloseFailed: true,
          sessionTainted: true,
        },
        terminalResult: {
          status: 'terminated',
          output: makeSegment({ stdout: 'unsafe\n' }),
          exit: { kind: 'signal', exitCode: null, processTerminated: false },
        },
      },
    },
  );
  assert.deepEqual(registry.reserveAdmittingCell({ threadId: THREAD_ID }), {
    ok: true,
    cellId: 'ptc_cell_taint_fail_2',
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

void test('execute_code queued cell cancellation owns no running resource and finalizes only its store', async () => {
  const settle = createDeferred<void>();
  let cancelCount = 0;
  let finalizedCount = 0;
  const persistedResults: PtcExecuteCodeCellRetainedResult[] = [];
  const registry = createPtcExecuteCodeCellRegistry({
    allowConcurrentCells: true,
    createCellId: makeCellIdFactory('ptc_cell_queued'),
    persistTerminalResult: async ({ cellId, result }) => {
      persistedResults.push(result);
      return {
        outputRef: `tool-output://ptc-test/${cellId}`,
        fullOutputBytes: 1,
        fullOutputChars: 1,
        status: 'terminated',
        exitCode: null,
      };
    },
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
  assert.deepEqual(persistedResults, [
    {
      status: 'terminated',
      output: makeSegment(),
      exit: { kind: 'signal', exitCode: null, processTerminated: false },
      store: { discardedWrites: 2 },
    },
  ]);
  assert.deepEqual(
    registry.readCellState({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      cellId: admitted.cellId,
      state: 'terminal_retained',
    },
  );
  assert.deepEqual(
    registry.readTerminalCellDurableOutput({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      outputRef: `tool-output://ptc-test/${admitted.cellId}`,
      fullOutputBytes: 1,
      fullOutputChars: 1,
      status: 'terminated',
      exitCode: null,
    },
  );
  assert.deepEqual(
    registry.takeTerminalCellResult({
      threadId: THREAD_ID,
      cellId: admitted.cellId,
    }),
    {
      ok: true,
      value: {
        status: 'terminated',
        output: makeSegment(),
        exit: { kind: 'signal', exitCode: null, processTerminated: false },
        store: { discardedWrites: 2 },
      },
    },
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
