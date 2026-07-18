import { randomUUID } from 'node:crypto';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '../../shared/process-command.js';
import type {
  PtcExecuteCodeCellDurableOutput,
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeResult,
  PtcExecuteCodeRuntimeStoreSummary,
  PtcExecuteCodeStoreError,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeCellRevisionSignal } from './execute-code-cell-revision-signal.js';
import {
  createPtcExecuteCodeCellTerminalRetentionStore,
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS,
  type BaseCellRecord,
  type PersistPtcExecuteCodeCellTerminalResult,
  type PtcExecuteCodeCellReapCallback,
  type PtcExecuteCodeCellReapCancel,
  type PtcExecuteCodeCellRetainedResult,
  type PtcExecuteCodeCellStoreFinalization,
  type PtcExecuteCodeCellTerminalResult,
  type TerminalCellLookupResult,
} from './execute-code-cell-terminal-retention.js';

export const PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS = 1_000;
const CLEANUP_DIAGNOSTIC_TOKEN_MAX_LENGTH = 80;
const CLEANUP_DIAGNOSTIC_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

type PtcExecuteCodeCellState =
  | 'admitting'
  | 'queued'
  | 'running'
  | 'terminating'
  | 'terminal_retained'
  | 'terminal_expired';

type PtcExecuteCodeCellCloseReason =
  | 'terminate'
  | 'run_abort'
  | 'run_terminal'
  | 'orphan_reap'
  | 'shutdown';

interface PtcExecuteCodeCellResources {
  effectiveTimeoutMs: number;
  handle: DetachedProcessHandle;
  closeBridge: () => Promise<void> | void;
  taintSession: (args: {
    reason: PtcExecuteCodeCellCloseReason;
  }) => Promise<boolean> | boolean;
  finalizePlacement?: () =>
    | Promise<PtcExecuteCodeCellPlacementFinalization>
    | PtcExecuteCodeCellPlacementFinalization;
  finalizeStore?: (
    status: PtcExecuteCodeCellTerminalResult['status'],
  ) => Promise<PtcExecuteCodeCellStoreFinalization>;
  terminalResultStateRoot?: string;
}

type PtcExecuteCodeCellPlacementFinalization =
  | { ok: true }
  | {
      ok: false;
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };

interface PtcExecuteCodeCellReapTimerPolicy {
  runningCellReapAfterMs?: number;
  scheduleReapTimeout?: (
    callback: PtcExecuteCodeCellReapCallback,
    delayMs: number,
  ) => PtcExecuteCodeCellReapCancel;
}

type CellAdmissionResult =
  | { ok: true; cellId: PtcExecuteCodeCellId }
  | {
      ok: false;
      reasonCode: 'cell_active';
      cellId: PtcExecuteCodeCellId;
      state: PtcExecuteCodeCellState;
    }
  | {
      ok: false;
      reasonCode: 'cell_result_unclaimed';
      cellId: PtcExecuteCodeCellId;
      state: 'terminal_retained';
    };

type CellLookupResult<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: 'cell_missing' };

type CloseCellResult =
  | {
      ok: true;
      status: 'terminated';
      output: DetachedProcessOutputSegment;
      exit: DetachedProcessExitInfo;
      bridgeClosed: boolean;
      sessionTainted: boolean;
      store?: PtcExecuteCodeRuntimeStoreSummary;
      storeError?: PtcExecuteCodeStoreError;
      cleanupDiagnostics?: CleanupDiagnostics;
    }
  | {
      ok: true;
      status: 'terminal_retained_kept' | 'terminal_retained_dropped';
      terminalResult: PtcExecuteCodeCellRetainedResult;
    }
  | {
      ok: true;
      status:
        | 'terminal_expired_dropped'
        | 'admission_released'
        | 'queued_cancelled';
      store?: PtcExecuteCodeRuntimeStoreSummary;
    }
  | { ok: false; reasonCode: 'cell_missing' };

interface AdmittingCellRecord extends BaseCellRecord {
  state: 'admitting';
}

interface QueuedCellRecord extends BaseCellRecord {
  state: 'queued';
  cancelAcquire: () => void;
  settlePromise: Promise<void>;
  finalizeStore?: (
    status: PtcExecuteCodeCellTerminalResult['status'],
  ) => Promise<PtcExecuteCodeCellStoreFinalization>;
  terminalResultStateRoot: string;
}

interface RunningCellRecord
  extends BaseCellRecord, PtcExecuteCodeCellResources {
  state: 'running';
  orphanReapTimer?: PtcExecuteCodeCellReapCancel;
}

interface TerminatingCellRecord
  extends BaseCellRecord, PtcExecuteCodeCellResources {
  state: 'terminating';
  closePromise: Promise<CloseCellResult>;
  reason: PtcExecuteCodeCellCloseReason;
  orphanReapTimer?: PtcExecuteCodeCellReapCancel;
}

type CellRecord =
  | AdmittingCellRecord
  | QueuedCellRecord
  | RunningCellRecord
  | TerminatingCellRecord;

export function createPtcExecuteCodeCellRegistry(
  options: PtcExecuteCodeCellReapTimerPolicy & {
    createCellId?: () => PtcExecuteCodeCellId;
    allowConcurrentCells?: boolean;
    now?: () => number;
    terminalResultMemoryRetentionMs?: number;
    persistTerminalResult?: PersistPtcExecuteCodeCellTerminalResult;
  } = {},
) {
  const activeCellsByThread = new Map<
    string,
    Map<PtcExecuteCodeCellId, CellRecord>
  >();
  const createCellId =
    options.createCellId ?? (() => `ptc_cell_${randomUUID()}`);
  const allowConcurrentCells = options.allowConcurrentCells === true;
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
  const runningCellReapAfterMs = options.runningCellReapAfterMs;
  if (
    runningCellReapAfterMs !== undefined &&
    (!Number.isInteger(runningCellReapAfterMs) || runningCellReapAfterMs < 1)
  ) {
    throw new Error('PTC execute_code running cell reap policy is invalid');
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

  function getActiveCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellRecord | undefined {
    return activeCellsByThread.get(args.threadId)?.get(args.cellId);
  }

  function readFirstActiveCell(threadId: string): CellRecord | undefined {
    return activeCellsByThread.get(threadId)?.values().next().value;
  }

  function hasActiveCells(threadId: string): boolean {
    return (activeCellsByThread.get(threadId)?.size ?? 0) > 0;
  }

  function setActiveCell(record: CellRecord): void {
    const cells =
      activeCellsByThread.get(record.threadId) ??
      new Map<PtcExecuteCodeCellId, CellRecord>();
    cells.set(record.cellId, record);
    activeCellsByThread.set(record.threadId, cells);
  }

  function deleteActiveCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): void {
    const cells = activeCellsByThread.get(args.threadId);
    if (cells === undefined) {
      return;
    }
    cells.delete(args.cellId);
    if (cells.size === 0) {
      activeCellsByThread.delete(args.threadId);
    }
  }

  function readAllActiveCells(): CellRecord[] {
    return [...activeCellsByThread.values()].flatMap((cells) => [
      ...cells.values(),
    ]);
  }

  function reserveAdmittingCell(args: {
    threadId: string;
  }): CellAdmissionResult {
    const current = readFirstActiveCell(args.threadId);
    if (!allowConcurrentCells && current !== undefined) {
      return {
        ok: false,
        reasonCode: 'cell_active',
        cellId: current.cellId,
        state: current.state,
      };
    }
    const retained = getFirstClaimableRetainedCell(args.threadId);
    if (!allowConcurrentCells && retained !== undefined) {
      return {
        ok: false,
        reasonCode: 'cell_result_unclaimed',
        cellId: retained.cellId,
        state: retained.state,
      };
    }

    const cellId = createCellId();
    setActiveCell({
      threadId: args.threadId,
      cellId,
      state: 'admitting',
      createdAtMs: now(),
    });
    bumpRevision(args.threadId);
    return { ok: true, cellId };
  }

  function releaseAdmittingCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ released: boolean }> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId)) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state !== 'admitting' && current.state !== 'queued') {
      return { ok: true, value: { released: false } };
    }
    deleteActiveCell(args);
    bumpRevision(args.threadId);
    return { ok: true, value: { released: true } };
  }

  function markAdmittedCellQueued(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    terminalResultStateRoot: string;
    cancelAcquire: () => void;
    settlePromise: Promise<void>;
    finalizeStore?: (
      status: PtcExecuteCodeCellTerminalResult['status'],
    ) => Promise<PtcExecuteCodeCellStoreFinalization>;
  }): CellLookupResult<{ state: 'queued' }> {
    const current = getActiveCell(args);
    if (current?.state !== 'admitting') {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    setActiveCell({
      ...current,
      state: 'queued',
      cancelAcquire: args.cancelAcquire,
      settlePromise: args.settlePromise,
      terminalResultStateRoot: args.terminalResultStateRoot,
      ...(args.finalizeStore === undefined
        ? {}
        : { finalizeStore: args.finalizeStore }),
    });
    bumpRevision(args.threadId);
    return { ok: true, value: { state: 'queued' } };
  }

  function promoteAdmittedCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    resources: PtcExecuteCodeCellResources;
  }): CellLookupResult<{ state: 'running' }> {
    const current = getActiveCell(args);
    if (
      !isMatchingCell(current, args.cellId) ||
      (current.state !== 'admitting' && current.state !== 'queued')
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    const runningRecord: RunningCellRecord = {
      ...current,
      state: 'running',
      ...args.resources,
    };
    if (runningCellReapAfterMs !== undefined) {
      runningRecord.orphanReapTimer = scheduleReapTimeout(async () => {
        await closeCell({
          threadId: args.threadId,
          cellId: args.cellId,
          reason: 'orphan_reap',
        });
      }, runningCellReapAfterMs);
    }
    setActiveCell(runningRecord);
    bumpRevision(args.threadId);
    return { ok: true, value: { state: 'running' } };
  }

  function markRunningCellTerminalResultPersistence(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    stateRoot: string;
  }): CellLookupResult<{ marked: true }> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId) || current.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    setActiveCell({
      ...current,
      terminalResultStateRoot: args.stateRoot,
    });
    return { ok: true, value: { marked: true } };
  }

  async function recordTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    result: PtcExecuteCodeCellTerminalResult;
  }): Promise<
    CellLookupResult<{ bridgeClosed: boolean; sessionTainted?: boolean }>
  > {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId)) {
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
    const latest = getActiveCell(args);
    if (!isMatchingCell(latest, args.cellId)) {
      if (getRetainedTerminalCellRecord(args) !== undefined) {
        return { ok: true, value: { bridgeClosed } };
      }
      return { ok: false, reasonCode: 'cell_missing' };
    }

    if (latest.state === 'terminating' && latest.reason === 'orphan_reap') {
      if (bridgeClosed) {
        await retainTerminalCellResultIfMissing({
          threadId: latest.threadId,
          cellId: latest.cellId,
          createdAtMs: latest.createdAtMs,
          result: terminalResult,
          ...(latest.terminalResultStateRoot === undefined
            ? {}
            : { terminalResultStateRoot: latest.terminalResultStateRoot }),
        });
      } else {
        await retainCellCleanupFailure({
          threadId: latest.threadId,
          cellId: latest.cellId,
          createdAtMs: latest.createdAtMs,
          terminalResult,
          ...(latest.terminalResultStateRoot === undefined
            ? {}
            : { terminalResultStateRoot: latest.terminalResultStateRoot }),
          message: 'PTC execute_code cell cleanup failed after terminal exit',
          diagnostics: {
            callbackBridgeCloseFailed: true,
            ...bridgeCloseResult.diagnostics,
          },
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

    if (!bridgeClosed) {
      clearRunningCellReapTimer(latest);
      deleteActiveCell(args);
      const sessionTaintResult = await callBooleanWithoutThrow(
        () => latest.taintSession({ reason: 'run_terminal' }),
        'sessionTaint',
      );
      const placementFinalization = await finalizeCellPlacement(latest);
      const sessionTainted = sessionTaintResult.ok;
      await retainCellCleanupFailure({
        threadId: latest.threadId,
        cellId: latest.cellId,
        createdAtMs: latest.createdAtMs,
        terminalResult,
        ...(latest.terminalResultStateRoot === undefined
          ? {}
          : { terminalResultStateRoot: latest.terminalResultStateRoot }),
        message: 'PTC execute_code cell cleanup failed after terminal exit',
        diagnostics: {
          callbackBridgeCloseFailed: true,
          ...bridgeCloseResult.diagnostics,
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
      });
      bumpRevision(args.threadId);
      return { ok: true, value: { bridgeClosed: false, sessionTainted } };
    }

    const placementFinalization = await finalizeCellPlacement(latest);
    if (!placementFinalization.ok) {
      clearRunningCellReapTimer(latest);
      deleteActiveCell(args);
      await retainCellCleanupFailure({
        threadId: latest.threadId,
        cellId: latest.cellId,
        createdAtMs: latest.createdAtMs,
        terminalResult,
        ...(latest.terminalResultStateRoot === undefined
          ? {}
          : { terminalResultStateRoot: latest.terminalResultStateRoot }),
        message: placementFinalization.message,
        diagnostics: {
          placementReleaseFailed: true,
          ...placementFinalization.diagnostics,
        },
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
  }): Promise<CellLookupResult<{ retained: boolean }>> {
    const current = getActiveCell(args);
    const retained = getRetainedTerminalCellRecord(args);
    const terminalResult =
      args.terminalResult ?? getRetainedTerminalResult(args);
    const terminalResultStateRoot =
      current !== undefined && 'terminalResultStateRoot' in current
        ? current.terminalResultStateRoot
        : retained?.terminalResultStateRoot;
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

  function drainRunningCellOutput(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<DetachedProcessOutputSegment> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId) || current.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    return { ok: true, value: current.handle.drainNewOutput() };
  }

  function readRunningCellOutputRevision(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ outputRevision: number }> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId) || current.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    return {
      ok: true,
      value: { outputRevision: current.handle.getOutputRevision?.() ?? 0 },
    };
  }

  function waitForRunningCellOutputChange(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    afterOutputRevision: number;
    abortSignal?: AbortSignal;
  }): Promise<number> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId) || current.state !== 'running') {
      return Promise.resolve(args.afterOutputRevision + 1);
    }
    if (current.handle.waitForOutputChange === undefined) {
      return waitUntilAbort(args.abortSignal);
    }
    return current.handle.waitForOutputChange(
      args.afterOutputRevision,
      args.abortSignal,
    );
  }

  function readRunningCellEffectiveTimeoutMs(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ effectiveTimeoutMs: number }> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId) || current.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    return {
      ok: true,
      value: { effectiveTimeoutMs: current.effectiveTimeoutMs },
    };
  }

  async function closeCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    reason: PtcExecuteCodeCellCloseReason;
  }): Promise<CloseCellResult> {
    const current = getActiveCell(args);
    if (!isMatchingCell(current, args.cellId)) {
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

    const closePromise = closeRunningCell(current, args.reason);
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
  ): Promise<CloseCellResult> {
    clearRunningCellReapTimer(record);
    record.handle.terminate({
      graceMs: PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS,
    });
    const exit = await record.handle.exit;
    const output = record.handle.drainNewOutput();
    const storeFinalization =
      (await record.finalizeStore?.('terminated')) ?? {};
    const bridgeCloseResult = await callWithoutThrow(
      record.closeBridge,
      'callbackBridgeClose',
    );
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
      ...(!placementFinalization.ok
        ? {
            placementReleaseFailed: true,
            ...placementFinalization.diagnostics,
          }
        : {}),
    };

    const current = getActiveCell(record);
    if (isMatchingCell(current, record.cellId)) {
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
    markRunningCellTerminalResultPersistence,
    recordTerminalCellResult,
    recordCellCleanupFailure,
    recordCellStartFailure,
    readTerminalCellResult,
    readTerminalCellDurableOutput,
    takeTerminalCellResult,
    drainRunningCellOutput,
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

  function clearRunningCellReapTimer(
    record: RunningCellRecord | TerminatingCellRecord,
  ): void {
    if (record.orphanReapTimer === undefined) {
      return;
    }
    record.orphanReapTimer();
    delete record.orphanReapTimer;
  }
}

function isMatchingCell(
  record: CellRecord | undefined,
  cellId: PtcExecuteCodeCellId,
): record is CellRecord {
  return record !== undefined && record.cellId === cellId;
}

function scheduleDefaultReapTimeout(
  callback: PtcExecuteCodeCellReapCallback,
  delayMs: number,
): PtcExecuteCodeCellReapCancel {
  const timer = setTimeout(() => {
    void callback();
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
