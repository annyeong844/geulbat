import type {
  PtcExecuteCodeCellDurableOutput,
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeResult,
} from './execute-code-runtime-contract.js';
import {
  createPtcExecuteCodeActiveCellStore,
  isMatchingPtcExecuteCodeCell,
  type CellLookupResult,
  type CloseCellResult,
  type PtcExecuteCodeCellCloseReason,
  type PtcExecuteCodeCellPlacementFinalization,
  type PtcExecuteCodeCellReapTimerPolicy,
  type PtcExecuteCodeCellResources,
  type PtcExecuteCodeCellState,
  type RunningCellRecord,
} from './execute-code-cell-active-store.js';
import { createPtcExecuteCodeCellRevisionSignal } from './execute-code-cell-revision-signal.js';
import {
  createPtcExecuteCodeCellTerminalRetentionStore,
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS,
  type PersistPtcExecuteCodeCellTerminalResult,
  type PtcExecuteCodeCellReapCallback,
  type PtcExecuteCodeCellReapCancel,
  type PtcExecuteCodeCellRetainedResult,
  type PtcExecuteCodeCellTerminalResult,
  type TerminalCellLookupResult,
} from './execute-code-cell-terminal-retention.js';
import { runDetached } from '../../../utils/run-detached.js';

export const PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS = 1_000;
const CLEANUP_DIAGNOSTIC_TOKEN_MAX_LENGTH = 80;
const CLEANUP_DIAGNOSTIC_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

export function createPtcExecuteCodeCellRegistry(
  options: PtcExecuteCodeCellReapTimerPolicy & {
    createCellId?: () => PtcExecuteCodeCellId;
    allowConcurrentCells?: boolean;
    now?: () => number;
    terminalResultMemoryRetentionMs?: number;
    persistTerminalResult?: PersistPtcExecuteCodeCellTerminalResult;
  } = {},
) {
  const now = options.now ?? Date.now;
  const terminalResultMemoryRetentionMs =
    options.terminalResultMemoryRetentionMs ??
    PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS;
  if (
    !Number.isSafeInteger(terminalResultMemoryRetentionMs) ||
    terminalResultMemoryRetentionMs < 1
  ) {
    throw new Error(
      'PTC execute_code terminal result memory retention is invalid',
    );
  }
  const scheduleReapTimeout =
    options.scheduleReapTimeout ?? scheduleDefaultReapTimeout;
  // 변경 신호 백본 — 상태(카운터·waiter)는 신호기가 소유하고, 스레드
  // 프루닝 판정(활성/보존 셀이 모두 비었는가)만 여기서 주입한다.
  const {
    bumpRevision,
    getRevision,
    getThreadRevision,
    waitForRevisionChange,
    waitForThreadRevisionChange,
    waitUntilAbort,
  } = createPtcExecuteCodeCellRevisionSignal({
    isThreadIdle: (threadId) =>
      !hasActiveCells(threadId) && !hasRetainedCells(threadId),
  });

  // 터미널 결과 보존 스토어 — terminal 이후 상태(보존·만료·영속화·reap)는
  // retention 모듈이 소유하고, registry는 활성 셀 상태 머신만 남는다.
  const {
    hasRetainedCells,
    peekTerminalCell,
    peekFirstTerminalCell,
    readAllTerminalCells,
    getTerminalCellResult,
    getTerminalCellRecord,
    getFirstClaimableRetainedCell,
    isTerminalExpired,
    deleteExpiredTerminalRetainedCell,
    storeTerminalRetainedCell,
    retainTerminalCellResult,
    retainTerminalCellResultIfMissing,
    retainOrphanReapTerminalResult,
    retainCellCleanupFailure,
    createTerminalRetainedCellRecord,
    persistTerminalRetainedCell,
    getRetainedTerminalCellRecord,
    getRetainedTerminalResult,
    deleteTerminalRetainedCell,
  } = createPtcExecuteCodeCellTerminalRetentionStore({
    now,
    terminalResultMemoryRetentionMs,
    scheduleReapTimeout,
    ...(options.persistTerminalResult === undefined
      ? {}
      : { persistTerminalResult: options.persistTerminalResult }),
    bumpRevision,
  });

  const {
    getActiveCell,
    readFirstActiveCell,
    hasActiveCells,
    setActiveCell,
    deleteActiveCell,
    readAllActiveCells,
    reserveAdmittingCell,
    releaseAdmittingCell,
    markAdmittedCellQueued,
    promoteAdmittedCell,
    adoptRunningCell,
    replaceRunningCellCallbackHandler,
    markRunningCellTerminalResultPersistence,
    drainRunningCellOutput,
    prepareRunningCellOutputDelivery,
    commitRunningCellOutputDelivery,
    readRunningCellOutputRevision,
    waitForRunningCellOutputChange,
    readRunningCellEffectiveTimeoutMs,
    clearRunningCellReapTimer,
  } = createPtcExecuteCodeActiveCellStore({
    now,
    bumpRevision,
    getFirstClaimableRetainedCell,
    hasRetainedTerminalCell: (args) =>
      getRetainedTerminalCellRecord(args) !== undefined,
    closeOrphanCell: (args) =>
      closeCell({
        ...args,
        reason: 'orphan_reap',
      }),
    waitUntilAbort,
    scheduleReapTimeout,
    ...(options.createCellId === undefined
      ? {}
      : { createCellId: options.createCellId }),
    ...(options.allowConcurrentCells === undefined
      ? {}
      : { allowConcurrentCells: options.allowConcurrentCells }),
    ...(options.runningCellReapAfterMs === undefined
      ? {}
      : { runningCellReapAfterMs: options.runningCellReapAfterMs }),
  });

  async function recordTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    result: PtcExecuteCodeCellTerminalResult;
    buildRecoveryResult?: (
      result: PtcExecuteCodeCellRetainedResult,
    ) => PtcExecuteCodeRuntimeResult;
  }): Promise<
    CellLookupResult<{ bridgeClosed: boolean; sessionTainted?: boolean }>
  > {
    const current = getActiveCell(args);
    if (!isMatchingPtcExecuteCodeCell(current, args.cellId)) {
      if (getRetainedTerminalCellRecord(args) !== undefined) {
        return { ok: true, value: { bridgeClosed: true } };
      }
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state === 'admitting' || current.state === 'queued') {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    const terminalResult: PtcExecuteCodeCellTerminalResult = {
      ...args.result,
      ...(current.finalizeStore === undefined
        ? {}
        : await current.finalizeStore(
            current.state === 'running' &&
              args.result.status === 'completed' &&
              args.result.exit.kind === 'exit' &&
              args.result.exit.exitCode === 0
              ? 'completed'
              : 'terminated',
          )),
    };
    if (current.state === 'terminating' && current.reason === 'orphan_reap') {
      await retainTerminalCellResultIfMissing({
        threadId: current.threadId,
        cellId: current.cellId,
        createdAtMs: current.createdAtMs,
        result: terminalResult,
        ...(args.buildRecoveryResult === undefined
          ? {}
          : { recoveryResult: args.buildRecoveryResult(terminalResult) }),
        ...(current.terminalResultStateRoot === undefined
          ? {}
          : { terminalResultStateRoot: current.terminalResultStateRoot }),
      });
      bumpRevision(args.threadId);
      return { ok: true, value: { bridgeClosed: true } };
    }
    if (current.state === 'terminating') {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    const bridgeCloseResult = await callWithoutThrow(
      current.closeBridge,
      'callbackBridgeClose',
    );
    const bridgeClosed = bridgeCloseResult.ok;
    try {
      await retainTerminalCellResultIfMissing({
        threadId: current.threadId,
        cellId: current.cellId,
        createdAtMs: current.createdAtMs,
        result: terminalResult,
        ...(args.buildRecoveryResult === undefined
          ? {}
          : { recoveryResult: args.buildRecoveryResult(terminalResult) }),
        ...(current.terminalResultStateRoot === undefined
          ? {}
          : { terminalResultStateRoot: current.terminalResultStateRoot }),
      });
    } catch (error: unknown) {
      clearRunningCellReapTimer(current);
      deleteActiveCell(args);
      bumpRevision(args.threadId);
      throw error;
    }
    const coordinateFinalization = await finalizeCellCoordinate(current);
    const latest = getActiveCell(args);
    if (!isMatchingPtcExecuteCodeCell(latest, args.cellId)) {
      if (getRetainedTerminalCellRecord(args) !== undefined) {
        return { ok: true, value: { bridgeClosed } };
      }
      return { ok: false, reasonCode: 'cell_missing' };
    }

    if (latest.state === 'terminating' && latest.reason === 'orphan_reap') {
      if (bridgeClosed && coordinateFinalization.ok) {
        await retainTerminalCellResultIfMissing({
          threadId: latest.threadId,
          cellId: latest.cellId,
          createdAtMs: latest.createdAtMs,
          result: terminalResult,
          ...(args.buildRecoveryResult === undefined
            ? {}
            : { recoveryResult: args.buildRecoveryResult(terminalResult) }),
          ...(latest.terminalResultStateRoot === undefined
            ? {}
            : { terminalResultStateRoot: latest.terminalResultStateRoot }),
        });
      } else {
        const cleanupResult: PtcExecuteCodeCellRetainedResult = {
          status: 'cleanup_failed',
          message: 'PTC execute_code cell cleanup failed after terminal exit',
          diagnostics: {
            ...(!bridgeClosed
              ? {
                  callbackBridgeCloseFailed: true,
                  ...bridgeCloseResult.diagnostics,
                }
              : {}),
            ...(!coordinateFinalization.ok
              ? {
                  cellCoordinateDeleteFailed: true,
                  ...coordinateFinalization.diagnostics,
                }
              : {}),
          },
          terminalResult,
        };
        await retainCellCleanupFailure({
          threadId: latest.threadId,
          cellId: latest.cellId,
          createdAtMs: latest.createdAtMs,
          terminalResult,
          ...(latest.terminalResultStateRoot === undefined
            ? {}
            : { terminalResultStateRoot: latest.terminalResultStateRoot }),
          message: cleanupResult.message,
          diagnostics: cleanupResult.diagnostics,
          ...(args.buildRecoveryResult === undefined
            ? {}
            : {
                recoveryResult: args.buildRecoveryResult(cleanupResult),
              }),
        });
      }
      bumpRevision(args.threadId);
      return { ok: true, value: { bridgeClosed } };
    }

    if (latest.state === 'terminating') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    if (latest.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    if (!bridgeClosed || !coordinateFinalization.ok) {
      clearRunningCellReapTimer(latest);
      deleteActiveCell(args);
      const sessionTaintResult = await callBooleanWithoutThrow(
        () => latest.taintSession({ reason: 'run_terminal' }),
        'sessionTaint',
      );
      const placementFinalization = await finalizeCellPlacement(latest);
      const sessionTainted = sessionTaintResult.ok;
      const cleanupResult: PtcExecuteCodeCellRetainedResult = {
        status: 'cleanup_failed',
        message: 'PTC execute_code cell cleanup failed after terminal exit',
        diagnostics: {
          ...(!bridgeClosed
            ? {
                callbackBridgeCloseFailed: true,
                ...bridgeCloseResult.diagnostics,
              }
            : {}),
          ...(!coordinateFinalization.ok
            ? {
                cellCoordinateDeleteFailed: true,
                ...coordinateFinalization.diagnostics,
              }
            : {}),
          ...(sessionTainted
            ? {}
            : {
                sessionCloseFailed: true,
                sessionTainted: true,
                ...sessionTaintResult.diagnostics,
              }),
          ...(!placementFinalization.ok
            ? {
                placementReleaseFailed: true,
                ...placementFinalization.diagnostics,
              }
            : {}),
        },
        terminalResult,
      };
      await retainCellCleanupFailure({
        threadId: latest.threadId,
        cellId: latest.cellId,
        createdAtMs: latest.createdAtMs,
        terminalResult,
        ...(latest.terminalResultStateRoot === undefined
          ? {}
          : { terminalResultStateRoot: latest.terminalResultStateRoot }),
        message: cleanupResult.message,
        diagnostics: cleanupResult.diagnostics,
        ...(args.buildRecoveryResult === undefined
          ? {}
          : { recoveryResult: args.buildRecoveryResult(cleanupResult) }),
      });
      bumpRevision(args.threadId);
      return { ok: true, value: { bridgeClosed, sessionTainted } };
    }

    const placementFinalization = await finalizeCellPlacement(latest);
    if (!placementFinalization.ok) {
      clearRunningCellReapTimer(latest);
      deleteActiveCell(args);
      const cleanupResult: PtcExecuteCodeCellRetainedResult = {
        status: 'cleanup_failed',
        message: placementFinalization.message,
        diagnostics: {
          placementReleaseFailed: true,
          ...placementFinalization.diagnostics,
        },
        terminalResult,
      };
      await retainCellCleanupFailure({
        threadId: latest.threadId,
        cellId: latest.cellId,
        createdAtMs: latest.createdAtMs,
        terminalResult,
        ...(latest.terminalResultStateRoot === undefined
          ? {}
          : { terminalResultStateRoot: latest.terminalResultStateRoot }),
        message: cleanupResult.message,
        diagnostics: cleanupResult.diagnostics,
        ...(args.buildRecoveryResult === undefined
          ? {}
          : { recoveryResult: args.buildRecoveryResult(cleanupResult) }),
      });
      bumpRevision(args.threadId);
      return { ok: true, value: { bridgeClosed: true } };
    }

    clearRunningCellReapTimer(latest);
    deleteActiveCell(args);
    await retainTerminalCellResult({
      threadId: latest.threadId,
      cellId: latest.cellId,
      createdAtMs: latest.createdAtMs,
      result: terminalResult,
      ...(args.buildRecoveryResult === undefined
        ? {}
        : { recoveryResult: args.buildRecoveryResult(terminalResult) }),
      ...(latest.terminalResultStateRoot === undefined
        ? {}
        : { terminalResultStateRoot: latest.terminalResultStateRoot }),
    });
    bumpRevision(args.threadId);

    return { ok: true, value: { bridgeClosed: true } };
  }

  async function recordCellCleanupFailure(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    message: string;
    diagnostics: Record<string, string | number | boolean>;
    terminalResult?: PtcExecuteCodeCellTerminalResult;
    terminalResultStateRoot?: string;
  }): Promise<CellLookupResult<{ retained: boolean }>> {
    const current = getActiveCell(args);
    const retained = getRetainedTerminalCellRecord(args);
    const terminalResult =
      args.terminalResult ?? getRetainedTerminalResult(args);
    const terminalResultStateRoot =
      current !== undefined && 'terminalResultStateRoot' in current
        ? current.terminalResultStateRoot
        : (retained?.terminalResultStateRoot ?? args.terminalResultStateRoot);
    if (current !== undefined) {
      if (current.state === 'running' || current.state === 'terminating') {
        clearRunningCellReapTimer(current);
      }
      deleteActiveCell(args);
    }
    await retainCellCleanupFailure({
      threadId: args.threadId,
      cellId: args.cellId,
      createdAtMs: current?.createdAtMs ?? retained?.createdAtMs ?? now(),
      ...(terminalResult === undefined ? {} : { terminalResult }),
      ...(terminalResultStateRoot === undefined
        ? {}
        : { terminalResultStateRoot }),
      message: args.message,
      diagnostics: args.diagnostics,
    });
    bumpRevision(args.threadId);
    return { ok: true, value: { retained: true } };
  }

  async function recordCellStartFailure(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    failure: Extract<PtcExecuteCodeRuntimeResult, { ok: false }>;
  }): Promise<CellLookupResult<{ retained: boolean }>> {
    const current = getActiveCell(args);
    if (current === undefined) {
      return getRetainedTerminalCellRecord(args) === undefined
        ? { ok: false, reasonCode: 'cell_missing' }
        : { ok: true, value: { retained: true } };
    }
    if (current.state !== 'admitting' && current.state !== 'queued') {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    deleteActiveCell(args);
    const storeFinalization =
      current.state === 'queued'
        ? await current.finalizeStore?.('terminated')
        : undefined;
    const failure =
      args.failure.store === undefined &&
      storeFinalization?.store !== undefined &&
      'discardedWrites' in storeFinalization.store
        ? { ...args.failure, store: storeFinalization.store }
        : args.failure;
    const retained = createTerminalRetainedCellRecord({
      threadId: current.threadId,
      cellId: current.cellId,
      createdAtMs: current.createdAtMs,
      ...(current.state === 'queued'
        ? { terminalResultStateRoot: current.terminalResultStateRoot }
        : {}),
      result: { status: 'start_failed', failure },
    });
    storeTerminalRetainedCell(retained);
    await persistTerminalRetainedCell(retained);
    bumpRevision(args.threadId);
    return { ok: true, value: { retained: true } };
  }

  function readTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): TerminalCellLookupResult {
    return getTerminalCellResult(args);
  }

  function readTerminalCellDurableOutput(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): PtcExecuteCodeCellDurableOutput | undefined {
    return getRetainedTerminalCellRecord(args)?.durableOutput;
  }

  function takeTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): TerminalCellLookupResult {
    const current = getTerminalCellRecord(args);
    if (!current.ok) {
      return current;
    }

    deleteTerminalRetainedCell(args);
    bumpRevision(args.threadId);
    return { ok: true, value: current.value.result };
  }

  async function closeCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    reason: PtcExecuteCodeCellCloseReason;
    buildRecoveryResult?: (
      result: PtcExecuteCodeCellRetainedResult,
    ) => PtcExecuteCodeRuntimeResult;
  }): Promise<CloseCellResult> {
    const current = getActiveCell(args);
    if (!isMatchingPtcExecuteCodeCell(current, args.cellId)) {
      const retained = peekTerminalCell(args);
      if (retained === undefined) {
        return { ok: false, reasonCode: 'cell_missing' };
      }
      if (
        args.reason === 'orphan_reap' &&
        retained.state === 'terminal_retained'
      ) {
        return {
          ok: true,
          status: 'terminal_retained_kept',
          terminalResult: retained.result,
        };
      }
      deleteTerminalRetainedCell(args);
      bumpRevision(args.threadId);
      if (retained.state === 'terminal_expired') {
        return {
          ok: true,
          status: 'terminal_expired_dropped',
        };
      }
      return {
        ok: true,
        status: 'terminal_retained_dropped',
        terminalResult: retained.result,
      };
    }

    if (current.state === 'admitting') {
      deleteActiveCell(args);
      bumpRevision(args.threadId);
      return { ok: true, status: 'admission_released' };
    }

    if (current.state === 'queued') {
      deleteActiveCell(args);
      bumpRevision(args.threadId);
      current.cancelAcquire();
      const storeFinalization =
        (await current.finalizeStore?.('terminated')) ?? {};
      await current.settlePromise;
      if (args.reason === 'terminate') {
        await retainTerminalCellResult({
          threadId: current.threadId,
          cellId: current.cellId,
          createdAtMs: current.createdAtMs,
          result: {
            status: 'terminated',
            output: { stdout: '', stderr: '' },
            exit: {
              kind: 'signal',
              exitCode: null,
              processTerminated: false,
            },
            ...storeFinalization,
          },
          ...(current.terminalResultStateRoot === undefined
            ? {}
            : {
                terminalResultStateRoot: current.terminalResultStateRoot,
              }),
        });
      }
      return {
        ok: true,
        status: 'queued_cancelled',
        ...(storeFinalization.store === undefined
          ? {}
          : { store: storeFinalization.store }),
      };
    }

    if (current.state === 'terminating') {
      return await current.closePromise;
    }

    const closePromise = closeRunningCell(
      current,
      args.reason,
      args.buildRecoveryResult,
    );
    setActiveCell({
      ...current,
      state: 'terminating',
      closePromise,
      reason: args.reason,
    });
    bumpRevision(args.threadId);
    return await closePromise;
  }

  async function closeAllCells(args: {
    reason: PtcExecuteCodeCellCloseReason;
  }): Promise<{ closedCount: number }> {
    const activeSnapshot = readAllActiveCells().map((cell) => ({
      threadId: cell.threadId,
      cellId: cell.cellId,
    }));
    const retainedSnapshot = readAllTerminalCells().map((cell) => ({
      threadId: cell.threadId,
      cellId: cell.cellId,
    }));
    let closedCount = 0;
    for (const cell of activeSnapshot) {
      const closed = await closeCell({
        threadId: cell.threadId,
        cellId: cell.cellId,
        reason: args.reason,
      });
      if (closed.ok) {
        closedCount += 1;
      }
    }
    for (const cell of retainedSnapshot) {
      const closed = await closeCell({
        threadId: cell.threadId,
        cellId: cell.cellId,
        reason: args.reason,
      });
      if (closed.ok) {
        closedCount += 1;
      }
    }
    return { closedCount };
  }

  async function closeRunningCell(
    record: RunningCellRecord,
    reason: PtcExecuteCodeCellCloseReason,
    buildRecoveryResult:
      | ((
          result: PtcExecuteCodeCellRetainedResult,
        ) => PtcExecuteCodeRuntimeResult)
      | undefined,
  ): Promise<CloseCellResult> {
    clearRunningCellReapTimer(record);
    record.handle.terminate({
      graceMs: PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
    });
    const exit = await record.handle.exit;
    const output = record.handle.drainNewOutput();
    const storeFinalization =
      (await record.finalizeStore?.('terminated')) ?? {};
    const terminalResult: PtcExecuteCodeCellTerminalResult = {
      status: 'terminated',
      output,
      exit,
      ...storeFinalization,
    };
    if (reason === 'terminate' || buildRecoveryResult !== undefined) {
      // The restart-readable result must exist before the live coordinate is
      // deleted. A daemon death after coordinate finalization can then recover
      // the exact termination outcome instead of reporting a missing cell.
      await retainTerminalCellResultIfMissing({
        threadId: record.threadId,
        cellId: record.cellId,
        createdAtMs: record.createdAtMs,
        result: terminalResult,
        ...(buildRecoveryResult === undefined
          ? {}
          : { recoveryResult: buildRecoveryResult(terminalResult) }),
        ...(record.terminalResultStateRoot === undefined
          ? {}
          : {
              terminalResultStateRoot: record.terminalResultStateRoot,
            }),
      });
    }
    const bridgeCloseResult = await callWithoutThrow(
      record.closeBridge,
      'callbackBridgeClose',
    );
    const coordinateFinalization = await finalizeCellCoordinate(record);
    const sessionTaintResult = await callBooleanWithoutThrow(
      () => record.taintSession({ reason }),
      'sessionTaint',
    );
    const placementFinalization = await finalizeCellPlacement(record);
    const bridgeClosed = bridgeCloseResult.ok;
    const sessionTainted = sessionTaintResult.ok;
    const cleanupDiagnostics = {
      ...(!bridgeClosed
        ? {
            callbackBridgeCloseFailed: true,
            ...bridgeCloseResult.diagnostics,
          }
        : {}),
      ...(!sessionTainted
        ? {
            sessionCloseFailed: true,
            sessionTainted: true,
            ...sessionTaintResult.diagnostics,
          }
        : {}),
      ...(!coordinateFinalization.ok
        ? {
            cellCoordinateDeleteFailed: true,
            ...coordinateFinalization.diagnostics,
          }
        : {}),
      ...(!placementFinalization.ok
        ? {
            placementReleaseFailed: true,
            ...placementFinalization.diagnostics,
          }
        : {}),
    };

    const current = getActiveCell(record);
    if (isMatchingPtcExecuteCodeCell(current, record.cellId)) {
      deleteActiveCell(record);
      bumpRevision(record.threadId);
    }
    if (reason === 'orphan_reap') {
      await retainOrphanReapTerminalResult({
        record,
        output,
        exit,
        storeFinalization,
        cleanupDiagnostics,
      });
      bumpRevision(record.threadId);
    } else if (reason === 'terminate') {
      if (Object.keys(cleanupDiagnostics).length > 0) {
        await retainCellCleanupFailure({
          threadId: record.threadId,
          cellId: record.cellId,
          createdAtMs: record.createdAtMs,
          terminalResult,
          message: 'PTC execute_code explicit termination cleanup failed',
          diagnostics: cleanupDiagnostics,
          ...(record.terminalResultStateRoot === undefined
            ? {}
            : {
                terminalResultStateRoot: record.terminalResultStateRoot,
              }),
        });
      }
      bumpRevision(record.threadId);
    } else if (
      reason === 'run_terminal' &&
      buildRecoveryResult !== undefined &&
      Object.keys(cleanupDiagnostics).length > 0
    ) {
      const cleanupResult: PtcExecuteCodeCellRetainedResult = {
        status: 'cleanup_failed',
        message: 'PTC execute_code cell cleanup failed after terminal signal',
        diagnostics: cleanupDiagnostics,
        terminalResult,
      };
      await retainCellCleanupFailure({
        threadId: record.threadId,
        cellId: record.cellId,
        createdAtMs: record.createdAtMs,
        terminalResult,
        message: cleanupResult.message,
        diagnostics: cleanupResult.diagnostics,
        recoveryResult: buildRecoveryResult(cleanupResult),
        ...(record.terminalResultStateRoot === undefined
          ? {}
          : {
              terminalResultStateRoot: record.terminalResultStateRoot,
            }),
      });
      bumpRevision(record.threadId);
    }

    return {
      ok: true,
      status: 'terminated',
      output,
      exit,
      bridgeClosed,
      sessionTainted,
      ...storeFinalization,
      ...(Object.keys(cleanupDiagnostics).length > 0
        ? { cleanupDiagnostics }
        : {}),
    };
  }

  function readCellState(args: {
    threadId: string;
    cellId?: PtcExecuteCodeCellId;
  }): { cellId: PtcExecuteCodeCellId; state: PtcExecuteCodeCellState } | null {
    const current =
      args.cellId === undefined
        ? readFirstActiveCell(args.threadId)
        : getActiveCell({ threadId: args.threadId, cellId: args.cellId });
    if (current !== undefined) {
      return { cellId: current.cellId, state: current.state };
    }
    const retained =
      args.cellId === undefined
        ? peekFirstTerminalCell(args.threadId)
        : peekTerminalCell({ threadId: args.threadId, cellId: args.cellId });
    if (
      retained?.state === 'terminal_retained' &&
      isTerminalExpired(retained)
    ) {
      const expired = deleteExpiredTerminalRetainedCell(retained);
      bumpRevision(expired.threadId);
      return { cellId: expired.cellId, state: expired.state };
    }
    return retained === undefined
      ? null
      : { cellId: retained.cellId, state: retained.state };
  }

  return {
    reserveAdmittingCell,
    releaseAdmittingCell,
    markAdmittedCellQueued,
    promoteAdmittedCell,
    adoptRunningCell,
    replaceRunningCellCallbackHandler,
    markRunningCellTerminalResultPersistence,
    recordTerminalCellResult,
    recordCellCleanupFailure,
    recordCellStartFailure,
    readTerminalCellResult,
    readTerminalCellDurableOutput,
    takeTerminalCellResult,
    drainRunningCellOutput,
    prepareRunningCellOutputDelivery,
    commitRunningCellOutputDelivery,
    readRunningCellOutputRevision,
    waitForRunningCellOutputChange,
    readRunningCellEffectiveTimeoutMs,
    closeCell,
    closeAllCells,
    readCellState,
    getRevision,
    waitForRevisionChange,
    getThreadRevision,
    waitForThreadRevisionChange,
  };
}

function scheduleDefaultReapTimeout(
  callback: PtcExecuteCodeCellReapCallback,
  delayMs: number,
): PtcExecuteCodeCellReapCancel {
  const timer = setTimeout(() => {
    runDetached('ptc/cell-reap', () => callback());
  }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

async function finalizeCellPlacement(
  resources: PtcExecuteCodeCellResources,
): Promise<PtcExecuteCodeCellPlacementFinalization> {
  if (resources.finalizePlacement === undefined) {
    return { ok: true };
  }
  try {
    return await resources.finalizePlacement();
  } catch (error: unknown) {
    return {
      ok: false,
      message: 'PTC execute_code placement cleanup failed',
      diagnostics: sanitizeCleanupError(error, 'placementRelease'),
    };
  }
}

async function finalizeCellCoordinate(
  resources: PtcExecuteCodeCellResources,
): Promise<PtcExecuteCodeCellPlacementFinalization> {
  if (resources.finalizeCoordinate === undefined) {
    return { ok: true };
  }
  try {
    await resources.finalizeCoordinate();
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      message: 'PTC execute_code cell coordinate cleanup failed',
      diagnostics: sanitizeCleanupError(error, 'cellCoordinateDelete'),
    };
  }
}

async function callWithoutThrow(
  callback: () => Promise<void> | void,
  diagnosticsPrefix: string,
): Promise<{ ok: true } | { ok: false; diagnostics: CleanupDiagnostics }> {
  try {
    await callback();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      diagnostics: sanitizeCleanupError(error, diagnosticsPrefix),
    };
  }
}

async function callBooleanWithoutThrow(
  callback: () => Promise<boolean> | boolean,
  diagnosticsPrefix: string,
): Promise<{ ok: boolean; diagnostics: CleanupDiagnostics }> {
  try {
    return { ok: await callback(), diagnostics: {} };
  } catch (error) {
    return {
      ok: false,
      diagnostics: sanitizeCleanupError(error, diagnosticsPrefix),
    };
  }
}

type CleanupDiagnostics = Record<string, string | number | boolean>;

function sanitizeCleanupError(
  error: unknown,
  diagnosticsPrefix: string,
): CleanupDiagnostics {
  const diagnostics: CleanupDiagnostics = {
    [`${diagnosticsPrefix}ErrorName`]: cleanupErrorName(error),
  };
  const code = cleanupErrorCode(error);
  if (code !== undefined) {
    diagnostics[`${diagnosticsPrefix}ErrorCode`] = code;
  }
  return diagnostics;
}

function cleanupErrorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return sanitizeCleanupDiagnosticToken(error.name) ?? 'Error';
  }
  return 'NonErrorThrown';
}

function cleanupErrorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  if (typeof code === 'number') {
    return Number.isSafeInteger(code) ? code : undefined;
  }
  return typeof code === 'string'
    ? sanitizeCleanupDiagnosticToken(code)
    : undefined;
}

function sanitizeCleanupDiagnosticToken(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > CLEANUP_DIAGNOSTIC_TOKEN_MAX_LENGTH ||
    !CLEANUP_DIAGNOSTIC_TOKEN_PATTERN.test(value)
  ) {
    return undefined;
  }
  return value;
}
