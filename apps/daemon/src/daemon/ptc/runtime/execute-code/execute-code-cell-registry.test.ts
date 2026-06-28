import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '../../shared/process-command.js';

import {
  createPtcExecuteCodeCellRegistry,
  PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
} from './execute-code-cell-registry.js';
import type { PtcExecuteCodeCellId } from './execute-code-runtime-contract.js';

const THREAD_ID = 'thread-ptc-cell-registry';

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
    terminalResultRetentionMs: 50,
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

void test('execute_code cell registry prunes expired retained output during admission lookup', async () => {
  let now = 4_000;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: makeCellIdFactory('ptc_cell_expire_admission'),
    now: () => now,
    terminalResultRetentionMs: 25,
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
    terminalResultRetentionMs: 10,
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
      return timerHandle;
    },
    clearReapTimeout: (timer) => {
      clearedTimers.push(timer);
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
    terminalResultRetentionMs: 50,
    scheduleReapTimeout: (callback, delayMs) => {
      const entry = { callback, delayMs };
      scheduled.push(entry);
      return entry;
    },
    clearReapTimeout: (timer) => {
      const index = scheduled.indexOf(
        timer as { callback: () => Promise<void> | void; delayMs: number },
      );
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
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
