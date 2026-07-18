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

export const PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS = 1_000;
export const PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS = 300_000;
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

export interface PtcExecuteCodeCellTerminalResult {
  status: 'completed' | 'terminated';
  output: DetachedProcessOutputSegment;
  exit: DetachedProcessExitInfo;
  store?: PtcExecuteCodeRuntimeStoreSummary;
  storeError?: PtcExecuteCodeStoreError;
}

export interface PtcExecuteCodeCellStoreFinalization {
  store?: PtcExecuteCodeRuntimeStoreSummary;
  storeError?: PtcExecuteCodeStoreError;
}

interface PtcExecuteCodeCellCleanupFailureResult {
  status: 'cleanup_failed';
  message: string;
  diagnostics: Record<string, string | number | boolean>;
  terminalResult?: PtcExecuteCodeCellTerminalResult;
}

interface PtcExecuteCodeCellStartFailureResult {
  status: 'start_failed';
  failure: Extract<PtcExecuteCodeRuntimeResult, { ok: false }>;
}

export type PtcExecuteCodeCellRetainedResult =
  | PtcExecuteCodeCellTerminalResult
  | PtcExecuteCodeCellCleanupFailureResult
  | PtcExecuteCodeCellStartFailureResult;

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

type PersistPtcExecuteCodeCellTerminalResult = (args: {
  stateRoot: string;
  threadId: string;
  cellId: PtcExecuteCodeCellId;
  result: PtcExecuteCodeCellRetainedResult;
}) => Promise<PtcExecuteCodeCellDurableOutput | undefined>;

type PtcExecuteCodeCellPlacementFinalization =
  | { ok: true }
  | {
      ok: false;
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };

type PtcExecuteCodeCellReapCallback = () => Promise<void>;

type PtcExecuteCodeCellReapCancel = () => void;

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

type TerminalCellLookupResult =
  | { ok: true; value: PtcExecuteCodeCellRetainedResult }
  | { ok: false; reasonCode: 'cell_missing' | 'cell_expired' };

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

interface BaseCellRecord {
  threadId: string;
  cellId: PtcExecuteCodeCellId;
  createdAtMs: number;
}

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

interface TerminalRetainedCellRecord extends BaseCellRecord {
  state: 'terminal_retained';
  completedAtMs: number;
  memoryExpiresAtMs?: number;
  result: PtcExecuteCodeCellRetainedResult;
  durableOutput?: PtcExecuteCodeCellDurableOutput;
  terminalResultStateRoot?: string;
  retentionReapTimer?: PtcExecuteCodeCellReapCancel;
}

interface TerminalExpiredCellRecord extends BaseCellRecord {
  state: 'terminal_expired';
  completedAtMs: number;
  expiredAtMs: number;
}

type TerminalCellRecord =
  | TerminalRetainedCellRecord
  | TerminalExpiredCellRecord;

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
  const retainedCellsByThread = new Map<
    string,
    Map<PtcExecuteCodeCellId, TerminalCellRecord>
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
  const persistTerminalResult = options.persistTerminalResult;
  const terminalResultPersistenceByCell = new Map<string, Promise<void>>();
  const runningCellReapAfterMs = options.runningCellReapAfterMs;
  if (
    runningCellReapAfterMs !== undefined &&
    (!Number.isInteger(runningCellReapAfterMs) || runningCellReapAfterMs < 1)
  ) {
    throw new Error('PTC execute_code running cell reap policy is invalid');
  }
  const scheduleReapTimeout =
    options.scheduleReapTimeout ?? scheduleDefaultReapTimeout;
  let revision = 0;
  const revisionWaiters = new Set<(nextRevision: number) => void>();
  const threadRevisions = new Map<string, number>();
  const threadRevisionWaiters = new Map<
    string,
    Set<(nextRevision: number) => void>
  >();

  function bumpRevision(threadId?: string): void {
    revision += 1;
    const waiters = [...revisionWaiters];
    revisionWaiters.clear();
    for (const waiter of waiters) {
      waiter(revision);
    }
    if (threadId !== undefined) {
      bumpThreadRevision(threadId);
      pruneThreadRevisionIfIdle(threadId);
    }
  }

  function bumpThreadRevision(threadId: string): void {
    const nextRevision = getThreadRevision({ threadId }) + 1;
    threadRevisions.set(threadId, nextRevision);
    const waiters = threadRevisionWaiters.get(threadId);
    if (waiters === undefined) {
      return;
    }
    threadRevisionWaiters.delete(threadId);
    for (const waiter of waiters) {
      waiter(nextRevision);
    }
  }

  function pruneThreadRevisionIfIdle(threadId: string): void {
    if (hasActiveCells(threadId)) {
      return;
    }
    const retained = retainedCellsByThread.get(threadId);
    if (retained !== undefined && retained.size > 0) {
      return;
    }
    const waiters = threadRevisionWaiters.get(threadId);
    if (waiters !== undefined && waiters.size > 0) {
      return;
    }
    threadRevisions.delete(threadId);
  }

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
    const retained = retainedCellsByThread.get(args.threadId)?.get(args.cellId);
    return retained?.state === 'terminal_retained'
      ? retained.durableOutput
      : undefined;
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
      const retained = retainedCellsByThread
        .get(args.threadId)
        ?.get(args.cellId);
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
    const retainedSnapshot = [...retainedCellsByThread.values()].flatMap(
      (retainedByCellId) =>
        [...retainedByCellId.values()].map((cell) => ({
          threadId: cell.threadId,
          cellId: cell.cellId,
        })),
    );
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
    const retainedByCellId = retainedCellsByThread.get(args.threadId);
    const retained =
      args.cellId === undefined
        ? retainedByCellId?.values().next().value
        : retainedByCellId?.get(args.cellId);
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

  function getRevision(): number {
    return revision;
  }

  function getThreadRevision(args: { threadId: string }): number {
    return threadRevisions.get(args.threadId) ?? 0;
  }

  function waitForRevisionChange(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number> {
    if (revision !== afterRevision) {
      return Promise.resolve(revision);
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        revisionWaiters.delete(onRevisionChange);
        abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = () => {
        finish(() => reject(new Error('PTC execute_code cell wait aborted')));
      };

      const onRevisionChange = (nextRevision: number) => {
        if (nextRevision === afterRevision) {
          return;
        }
        finish(() => resolve(nextRevision));
      };

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      revisionWaiters.add(onRevisionChange);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitForThreadRevisionChange(args: {
    threadId: string;
    afterRevision: number;
    abortSignal?: AbortSignal;
  }): Promise<number> {
    const revision = getThreadRevision({ threadId: args.threadId });
    if (revision !== args.afterRevision) {
      return Promise.resolve(revision);
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        const waiters = threadRevisionWaiters.get(args.threadId);
        waiters?.delete(onThreadRevisionChange);
        if (waiters?.size === 0) {
          threadRevisionWaiters.delete(args.threadId);
        }
        args.abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() =>
          reject(new Error('PTC execute_code cell thread wait aborted')),
        );
      };
      const onThreadRevisionChange = (nextRevision: number) => {
        if (nextRevision === args.afterRevision) {
          return;
        }
        finish(() => resolve(nextRevision));
      };

      if (args.abortSignal?.aborted) {
        onAbort();
        return;
      }
      const waiters =
        threadRevisionWaiters.get(args.threadId) ??
        new Set<(nextRevision: number) => void>();
      waiters.add(onThreadRevisionChange);
      threadRevisionWaiters.set(args.threadId, waiters);
      args.abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitUntilAbort(abortSignal?: AbortSignal): Promise<number> {
    return new Promise<number>((_resolve, reject) => {
      const finish = () => {
        abortSignal?.removeEventListener('abort', onAbort);
        reject(new Error('PTC execute_code cell output wait aborted'));
      };
      const onAbort = () => {
        finish();
      };

      if (abortSignal?.aborted) {
        finish();
        return;
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function getTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): TerminalCellLookupResult {
    const current = getTerminalCellRecord(args);
    if (!current.ok) {
      return current;
    }
    return { ok: true, value: current.value.result };
  }

  function getTerminalCellRecord(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }):
    | { ok: true; value: TerminalRetainedCellRecord }
    | { ok: false; reasonCode: 'cell_missing' | 'cell_expired' } {
    const current = retainedCellsByThread.get(args.threadId)?.get(args.cellId);
    if (current === undefined) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state === 'terminal_expired') {
      deleteExpiredTerminalRetainedCell(current);
      bumpRevision(current.threadId);
      return { ok: false, reasonCode: 'cell_expired' };
    }
    if (isTerminalExpired(current)) {
      deleteExpiredTerminalRetainedCell(current);
      bumpRevision(current.threadId);
      return { ok: false, reasonCode: 'cell_expired' };
    }
    return { ok: true, value: current };
  }

  function getFirstClaimableRetainedCell(
    threadId: string,
  ): TerminalRetainedCellRecord | undefined {
    const retainedByCellId = retainedCellsByThread.get(threadId);
    if (retainedByCellId === undefined) {
      return undefined;
    }
    for (const retained of retainedByCellId.values()) {
      if (retained.state === 'terminal_expired') {
        deleteExpiredTerminalRetainedCell(retained);
        bumpRevision(retained.threadId);
        continue;
      }
      if (isTerminalExpired(retained)) {
        deleteExpiredTerminalRetainedCell(retained);
        bumpRevision(retained.threadId);
        continue;
      }
      return retained;
    }
    return undefined;
  }

  function isTerminalExpired(record: TerminalRetainedCellRecord): boolean {
    return (
      record.memoryExpiresAtMs !== undefined &&
      now() >= record.memoryExpiresAtMs
    );
  }

  function deleteExpiredTerminalRetainedCell(
    record: TerminalCellRecord,
  ): TerminalExpiredCellRecord {
    const expired: TerminalExpiredCellRecord =
      record.state === 'terminal_expired'
        ? record
        : {
            threadId: record.threadId,
            cellId: record.cellId,
            state: 'terminal_expired',
            createdAtMs: record.createdAtMs,
            completedAtMs: record.completedAtMs,
            expiredAtMs: now(),
          };
    deleteTerminalRetainedCell({
      threadId: record.threadId,
      cellId: record.cellId,
    });
    return expired;
  }

  function storeTerminalRetainedCell(record: TerminalCellRecord): void {
    const retainedByCellId =
      retainedCellsByThread.get(record.threadId) ??
      new Map<PtcExecuteCodeCellId, TerminalCellRecord>();
    const previous = retainedByCellId.get(record.cellId);
    if (previous?.state === 'terminal_retained') {
      clearTerminalRetainedCellReapTimer(previous);
    }
    if (
      record.state === 'terminal_retained' &&
      record.memoryExpiresAtMs !== undefined
    ) {
      scheduleTerminalRetainedCellReap(record);
    }
    retainedByCellId.set(record.cellId, record);
    retainedCellsByThread.set(record.threadId, retainedByCellId);
  }

  async function retainTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    result: PtcExecuteCodeCellTerminalResult;
    terminalResultStateRoot?: string;
  }): Promise<TerminalRetainedCellRecord> {
    const record = createTerminalRetainedCellRecord(args);
    storeTerminalRetainedCell(record);
    await persistTerminalRetainedCell(record);
    return record;
  }

  async function retainTerminalCellResultIfMissing(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    result: PtcExecuteCodeCellTerminalResult;
    terminalResultStateRoot?: string;
  }): Promise<TerminalRetainedCellRecord> {
    return (
      getRetainedTerminalCellRecord(args) ?? retainTerminalCellResult(args)
    );
  }

  async function retainOrphanReapTerminalResult(args: {
    record: RunningCellRecord;
    output: DetachedProcessOutputSegment;
    exit: DetachedProcessExitInfo;
    storeFinalization: PtcExecuteCodeCellStoreFinalization;
    cleanupDiagnostics: Record<string, string | number | boolean>;
  }): Promise<void> {
    const terminalResult = getRetainedTerminalResult(args.record) ?? {
      status: 'terminated',
      output: args.output,
      exit: args.exit,
      ...args.storeFinalization,
    };
    if (Object.keys(args.cleanupDiagnostics).length > 0) {
      await retainCellCleanupFailure({
        threadId: args.record.threadId,
        cellId: args.record.cellId,
        createdAtMs: args.record.createdAtMs,
        terminalResult,
        message: 'PTC execute_code cell orphan reaper cleanup failed',
        diagnostics: args.cleanupDiagnostics,
        ...(args.record.terminalResultStateRoot === undefined
          ? {}
          : {
              terminalResultStateRoot: args.record.terminalResultStateRoot,
            }),
      });
      return;
    }
    await retainTerminalCellResultIfMissing({
      threadId: args.record.threadId,
      cellId: args.record.cellId,
      createdAtMs: args.record.createdAtMs,
      result: terminalResult,
      ...(args.record.terminalResultStateRoot === undefined
        ? {}
        : { terminalResultStateRoot: args.record.terminalResultStateRoot }),
    });
  }

  async function retainCellCleanupFailure(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    message: string;
    diagnostics: Record<string, string | number | boolean>;
    terminalResult?: PtcExecuteCodeCellTerminalResult;
    terminalResultStateRoot?: string;
  }): Promise<void> {
    const record = createTerminalRetainedCellRecord({
      threadId: args.threadId,
      cellId: args.cellId,
      createdAtMs: args.createdAtMs,
      ...(args.terminalResultStateRoot === undefined
        ? {}
        : { terminalResultStateRoot: args.terminalResultStateRoot }),
      result: {
        status: 'cleanup_failed',
        message: args.message,
        diagnostics: args.diagnostics,
        ...(args.terminalResult !== undefined
          ? { terminalResult: args.terminalResult }
          : {}),
      },
    });
    storeTerminalRetainedCell(record);
    await persistTerminalRetainedCell(record);
  }

  function createTerminalRetainedCellRecord(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    result: PtcExecuteCodeCellRetainedResult;
    terminalResultStateRoot?: string;
  }): TerminalRetainedCellRecord {
    const completedAtMs = now();
    return {
      threadId: args.threadId,
      cellId: args.cellId,
      state: 'terminal_retained',
      createdAtMs: args.createdAtMs,
      completedAtMs,
      result: args.result,
      ...(args.terminalResultStateRoot === undefined
        ? {}
        : { terminalResultStateRoot: args.terminalResultStateRoot }),
    };
  }

  async function persistTerminalRetainedCell(
    record: TerminalRetainedCellRecord,
  ): Promise<void> {
    const stateRoot = record.terminalResultStateRoot;
    if (persistTerminalResult === undefined || stateRoot === undefined) {
      return;
    }

    const persistenceKey = JSON.stringify([record.threadId, record.cellId]);
    const previousPersistence =
      terminalResultPersistenceByCell.get(persistenceKey) ?? Promise.resolve();
    const persistence = previousPersistence
      .catch(() => undefined)
      .then(async () => {
        const durableOutput = await persistTerminalResult({
          stateRoot,
          threadId: record.threadId,
          cellId: record.cellId,
          result: record.result,
        });
        if (durableOutput === undefined) {
          return;
        }
        const current = retainedCellsByThread
          .get(record.threadId)
          ?.get(record.cellId);
        if (current !== record) {
          return;
        }
        record.durableOutput = durableOutput;
        record.memoryExpiresAtMs = now() + terminalResultMemoryRetentionMs;
        scheduleTerminalRetainedCellReap(record);
      });
    terminalResultPersistenceByCell.set(persistenceKey, persistence);
    try {
      await persistence;
    } finally {
      if (terminalResultPersistenceByCell.get(persistenceKey) === persistence) {
        terminalResultPersistenceByCell.delete(persistenceKey);
      }
    }
  }

  function getRetainedTerminalCellRecord(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): TerminalRetainedCellRecord | undefined {
    const retained = retainedCellsByThread.get(args.threadId)?.get(args.cellId);
    if (retained?.state !== 'terminal_retained') {
      return undefined;
    }
    return retained;
  }

  function getRetainedTerminalResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): PtcExecuteCodeCellTerminalResult | undefined {
    const retained = getRetainedTerminalCellRecord(args);
    if (retained === undefined) {
      return undefined;
    }
    if (retained.result.status === 'cleanup_failed') {
      return retained.result.terminalResult;
    }
    if (retained.result.status === 'start_failed') {
      return undefined;
    }
    return retained.result;
  }

  function deleteTerminalRetainedCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): void {
    const retainedByCellId = retainedCellsByThread.get(args.threadId);
    if (retainedByCellId === undefined) {
      return;
    }
    const retained = retainedByCellId.get(args.cellId);
    if (retained?.state === 'terminal_retained') {
      clearTerminalRetainedCellReapTimer(retained);
    }
    retainedByCellId.delete(args.cellId);
    if (retainedByCellId.size === 0) {
      retainedCellsByThread.delete(args.threadId);
    }
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

  function scheduleTerminalRetainedCellReap(
    record: TerminalRetainedCellRecord,
  ): void {
    if (record.memoryExpiresAtMs === undefined) {
      return;
    }
    const delayMs = Math.max(1, record.memoryExpiresAtMs - now());
    record.retentionReapTimer = scheduleReapTimeout(async () => {
      const current = retainedCellsByThread
        .get(record.threadId)
        ?.get(record.cellId);
      if (current !== record || current.state !== 'terminal_retained') {
        return;
      }
      delete current.retentionReapTimer;
      if (!isTerminalExpired(current)) {
        scheduleTerminalRetainedCellReap(current);
        return;
      }
      deleteExpiredTerminalRetainedCell(current);
      bumpRevision(current.threadId);
    }, delayMs);
  }

  function clearTerminalRetainedCellReapTimer(
    record: TerminalRetainedCellRecord,
  ): void {
    if (record.retentionReapTimer === undefined) {
      return;
    }
    record.retentionReapTimer();
    delete record.retentionReapTimer;
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
