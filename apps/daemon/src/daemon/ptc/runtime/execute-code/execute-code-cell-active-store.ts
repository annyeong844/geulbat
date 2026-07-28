import { randomUUID } from 'node:crypto';
import type { PtcEpochCallbackHandler } from '../../callback/epoch-callback.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
  DetachedProcessPreparedOutputDelivery,
} from './execute-code-cell-process.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeStoreSummary,
  PtcExecuteCodeStoreError,
} from './execute-code-runtime-contract.js';
import type {
  BaseCellRecord,
  PtcExecuteCodeCellReapCallback,
  PtcExecuteCodeCellReapCancel,
  PtcExecuteCodeCellRetainedResult,
  PtcExecuteCodeCellStoreFinalization,
  PtcExecuteCodeCellTerminalResult,
} from './execute-code-cell-terminal-retention.js';

export type PtcExecuteCodeCellState =
  | 'admitting'
  | 'queued'
  | 'running'
  | 'terminating'
  | 'terminal_retained'
  | 'terminal_expired';

export type PtcExecuteCodeCellCloseReason =
  | 'terminate'
  | 'run_abort'
  | 'run_terminal'
  | 'orphan_reap'
  | 'shutdown';

export interface PtcExecuteCodeCellResources {
  effectiveTimeoutMs: number;
  handle: DetachedProcessHandle;
  closeBridge: () => Promise<void> | void;
  taintSession: (args: {
    reason: PtcExecuteCodeCellCloseReason;
  }) => Promise<boolean> | boolean;
  finalizePlacement?: () =>
    | Promise<PtcExecuteCodeCellPlacementFinalization>
    | PtcExecuteCodeCellPlacementFinalization;
  finalizeCoordinate?: () => Promise<void> | void;
  replaceCallbackHandler?: (handler: PtcEpochCallbackHandler) => void;
  finalizeStore?: (
    status: PtcExecuteCodeCellTerminalResult['status'],
  ) => Promise<PtcExecuteCodeCellStoreFinalization>;
  terminalResultStateRoot?: string;
}

export type PtcExecuteCodeCellPlacementFinalization =
  | { ok: true }
  | {
      ok: false;
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };

export interface PtcExecuteCodeCellReapTimerPolicy {
  runningCellReapAfterMs?: number;
  scheduleReapTimeout?: (
    callback: PtcExecuteCodeCellReapCallback,
    delayMs: number,
  ) => PtcExecuteCodeCellReapCancel;
}

export type CellAdmissionResult =
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

export type CellLookupResult<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: 'cell_missing' };

export type CloseCellResult =
  | {
      ok: true;
      status: 'terminated';
      output: DetachedProcessOutputSegment;
      exit: DetachedProcessExitInfo;
      bridgeClosed: boolean;
      sessionTainted: boolean;
      store?: PtcExecuteCodeRuntimeStoreSummary;
      storeError?: PtcExecuteCodeStoreError;
      cleanupDiagnostics?: Record<string, string | number | boolean>;
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

export interface RunningCellRecord
  extends BaseCellRecord, PtcExecuteCodeCellResources {
  state: 'running';
  orphanReapTimer?: PtcExecuteCodeCellReapCancel;
}

export interface TerminatingCellRecord
  extends BaseCellRecord, PtcExecuteCodeCellResources {
  state: 'terminating';
  closePromise: Promise<CloseCellResult>;
  reason: PtcExecuteCodeCellCloseReason;
  orphanReapTimer?: PtcExecuteCodeCellReapCancel;
}

export type CellRecord =
  | AdmittingCellRecord
  | QueuedCellRecord
  | RunningCellRecord
  | TerminatingCellRecord;

export function createPtcExecuteCodeActiveCellStore(
  options: PtcExecuteCodeCellReapTimerPolicy & {
    scheduleReapTimeout: (
      callback: PtcExecuteCodeCellReapCallback,
      delayMs: number,
    ) => PtcExecuteCodeCellReapCancel;
    createCellId?: () => PtcExecuteCodeCellId;
    allowConcurrentCells?: boolean;
    now: () => number;
    bumpRevision: (threadId: string) => void;
    getFirstClaimableRetainedCell: (threadId: string) =>
      | {
          cellId: PtcExecuteCodeCellId;
          state: 'terminal_retained';
        }
      | undefined;
    hasRetainedTerminalCell: (args: {
      threadId: string;
      cellId: PtcExecuteCodeCellId;
    }) => boolean;
    closeOrphanCell: (args: {
      threadId: string;
      cellId: PtcExecuteCodeCellId;
    }) => Promise<CloseCellResult>;
    waitUntilAbort: (abortSignal?: AbortSignal) => Promise<number>;
  },
) {
  const activeCellsByThread = new Map<
    string,
    Map<PtcExecuteCodeCellId, CellRecord>
  >();
  const createCellId =
    options.createCellId ?? (() => `ptc_cell_${randomUUID()}`);
  const allowConcurrentCells = options.allowConcurrentCells === true;
  const runningCellReapAfterMs = options.runningCellReapAfterMs;
  if (
    runningCellReapAfterMs !== undefined &&
    (!Number.isInteger(runningCellReapAfterMs) || runningCellReapAfterMs < 1)
  ) {
    throw new Error('PTC execute_code running cell reap policy is invalid');
  }
  const scheduleReapTimeout = options.scheduleReapTimeout;

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
    cellId?: PtcExecuteCodeCellId;
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
    const retained = options.getFirstClaimableRetainedCell(args.threadId);
    if (!allowConcurrentCells && retained !== undefined) {
      return {
        ok: false,
        reasonCode: 'cell_result_unclaimed',
        cellId: retained.cellId,
        state: retained.state,
      };
    }

    const cellId = args.cellId ?? createCellId();
    setActiveCell({
      threadId: args.threadId,
      cellId,
      state: 'admitting',
      createdAtMs: options.now(),
    });
    options.bumpRevision(args.threadId);
    return { ok: true, cellId };
  }

  function releaseAdmittingCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ released: boolean }> {
    const current = getActiveCell(args);
    if (!isMatchingPtcExecuteCodeCell(current, args.cellId)) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state !== 'admitting' && current.state !== 'queued') {
      return { ok: true, value: { released: false } };
    }
    deleteActiveCell(args);
    options.bumpRevision(args.threadId);
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
    options.bumpRevision(args.threadId);
    return { ok: true, value: { state: 'queued' } };
  }

  function promoteAdmittedCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    resources: PtcExecuteCodeCellResources;
  }): CellLookupResult<{ state: 'running' }> {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
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
        await options.closeOrphanCell({
          threadId: args.threadId,
          cellId: args.cellId,
        });
      }, runningCellReapAfterMs);
    }
    setActiveCell(runningRecord);
    options.bumpRevision(args.threadId);
    return { ok: true, value: { state: 'running' } };
  }

  function adoptRunningCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    orphanReapAtMs?: number;
    resources: PtcExecuteCodeCellResources;
  }): CellLookupResult<{ state: 'running' }> {
    if (
      getActiveCell(args) !== undefined ||
      options.hasRetainedTerminalCell(args) ||
      (!allowConcurrentCells && hasActiveCells(args.threadId))
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    const runningRecord: RunningCellRecord = {
      threadId: args.threadId,
      cellId: args.cellId,
      state: 'running',
      createdAtMs: args.createdAtMs,
      ...args.resources,
    };
    const reapDelayMs =
      args.orphanReapAtMs === undefined
        ? runningCellReapAfterMs
        : Math.max(0, args.orphanReapAtMs - options.now());
    if (reapDelayMs !== undefined) {
      runningRecord.orphanReapTimer = scheduleReapTimeout(async () => {
        await options.closeOrphanCell({
          threadId: args.threadId,
          cellId: args.cellId,
        });
      }, reapDelayMs);
    }
    setActiveCell(runningRecord);
    options.bumpRevision(args.threadId);
    return { ok: true, value: { state: 'running' } };
  }

  function replaceRunningCellCallbackHandler(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    handler: PtcEpochCallbackHandler;
  }): CellLookupResult<{ replaced: boolean }> {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    current.replaceCallbackHandler?.(args.handler);
    return {
      ok: true,
      value: { replaced: current.replaceCallbackHandler !== undefined },
    };
  }

  function markRunningCellTerminalResultPersistence(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    stateRoot: string;
  }): CellLookupResult<{ marked: true }> {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    setActiveCell({
      ...current,
      terminalResultStateRoot: args.stateRoot,
    });
    return { ok: true, value: { marked: true } };
  }

  function drainRunningCellOutput(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<DetachedProcessOutputSegment> {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    return { ok: true, value: current.handle.drainNewOutput() };
  }

  function prepareRunningCellOutputDelivery(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }):
    | CellLookupResult<DetachedProcessPreparedOutputDelivery>
    | { ok: false; reasonCode: 'delivery_unavailable' } {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.handle.prepareOutputDelivery === undefined) {
      return { ok: false, reasonCode: 'delivery_unavailable' };
    }
    return { ok: true, value: current.handle.prepareOutputDelivery() };
  }

  function commitRunningCellOutputDelivery(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ committed: true }> {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.handle.commitPreparedOutputDelivery === undefined) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    current.handle.commitPreparedOutputDelivery();
    return { ok: true, value: { committed: true } };
  }

  function readRunningCellOutputRevision(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ outputRevision: number }> {
    const current = getActiveCell(args);
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
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
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return Promise.resolve(args.afterOutputRevision + 1);
    }
    if (current.handle.waitForOutputChange === undefined) {
      return options.waitUntilAbort(args.abortSignal);
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
    if (
      !isMatchingPtcExecuteCodeCell(current, args.cellId) ||
      current.state !== 'running'
    ) {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    return {
      ok: true,
      value: { effectiveTimeoutMs: current.effectiveTimeoutMs },
    };
  }

  function clearRunningCellReapTimer(
    record: RunningCellRecord | TerminatingCellRecord,
  ): void {
    if (record.orphanReapTimer === undefined) {
      return;
    }
    record.orphanReapTimer();
    delete record.orphanReapTimer;
  }

  return {
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
  };
}

export function isMatchingPtcExecuteCodeCell(
  record: CellRecord | undefined,
  cellId: PtcExecuteCodeCellId,
): record is CellRecord {
  return record?.cellId === cellId;
}
