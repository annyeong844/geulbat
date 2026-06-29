import { randomUUID } from 'node:crypto';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '../../shared/process-command.js';
import type { PtcExecuteCodeCellId } from './execute-code-runtime-contract.js';

export const PTC_EXECUTE_CODE_CELL_TERMINATE_GRACE_MS = 1_000;
const CLEANUP_DIAGNOSTIC_TOKEN_MAX_LENGTH = 80;
const CLEANUP_DIAGNOSTIC_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

type PtcExecuteCodeCellState =
  | 'admitting'
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

export interface PtcExecuteCodeCellTerminalResult {
  status: 'completed' | 'terminated';
  output: DetachedProcessOutputSegment;
  exit: DetachedProcessExitInfo;
}

interface PtcExecuteCodeCellCleanupFailureResult {
  status: 'cleanup_failed';
  message: string;
  diagnostics: Record<string, string | number | boolean>;
  terminalResult?: PtcExecuteCodeCellTerminalResult;
}

export type PtcExecuteCodeCellRetainedResult =
  | PtcExecuteCodeCellTerminalResult
  | PtcExecuteCodeCellCleanupFailureResult;

interface PtcExecuteCodeCellResources {
  effectiveTimeoutMs: number;
  handle: DetachedProcessHandle;
  closeBridge: () => Promise<void> | void;
  taintSession: (args: {
    reason: PtcExecuteCodeCellCloseReason;
  }) => Promise<boolean> | boolean;
}

type PtcExecuteCodeCellReapCallback = () => Promise<void>;

interface PtcExecuteCodeCellReapTimerPolicy {
  runningCellReapAfterMs?: number;
  scheduleReapTimeout?: (
    callback: PtcExecuteCodeCellReapCallback,
    delayMs: number,
  ) => unknown;
  clearReapTimeout?: (timer: unknown) => void;
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
      cleanupDiagnostics?: CleanupDiagnostics;
    }
  | {
      ok: true;
      status: 'terminal_retained_kept' | 'terminal_retained_dropped';
      terminalResult: PtcExecuteCodeCellRetainedResult;
    }
  | {
      ok: true;
      status: 'terminal_expired_dropped' | 'admission_released';
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

interface RunningCellRecord
  extends BaseCellRecord, PtcExecuteCodeCellResources {
  state: 'running';
  orphanReapTimer?: unknown;
}

interface TerminatingCellRecord
  extends BaseCellRecord, PtcExecuteCodeCellResources {
  state: 'terminating';
  closePromise: Promise<CloseCellResult>;
  reason: PtcExecuteCodeCellCloseReason;
  orphanReapTimer?: unknown;
}

interface TerminalRetainedCellRecord extends BaseCellRecord {
  state: 'terminal_retained';
  completedAtMs: number;
  expiresAtMs: number;
  result: PtcExecuteCodeCellRetainedResult;
  retentionReapTimer?: unknown;
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
  | RunningCellRecord
  | TerminatingCellRecord;

export function createPtcExecuteCodeCellRegistry(
  options: PtcExecuteCodeCellReapTimerPolicy & {
    createCellId?: () => PtcExecuteCodeCellId;
    now?: () => number;
    terminalResultRetentionMs?: number;
  } = {},
) {
  const activeCellsByThread = new Map<string, CellRecord>();
  const retainedCellsByThread = new Map<
    string,
    Map<PtcExecuteCodeCellId, TerminalCellRecord>
  >();
  const createCellId =
    options.createCellId ?? (() => `ptc_cell_${randomUUID()}`);
  const now = options.now ?? Date.now;
  const terminalResultRetentionMs =
    options.terminalResultRetentionMs ?? 5 * 60 * 1000;
  if (
    !Number.isInteger(terminalResultRetentionMs) ||
    terminalResultRetentionMs < 1
  ) {
    throw new Error('PTC execute_code terminal result retention is invalid');
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
  const clearReapTimeout = options.clearReapTimeout ?? clearDefaultReapTimeout;
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
    if (activeCellsByThread.has(threadId)) {
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

  function reserveAdmittingCell(args: {
    threadId: string;
  }): CellAdmissionResult {
    const current = activeCellsByThread.get(args.threadId);
    if (current !== undefined) {
      return {
        ok: false,
        reasonCode: 'cell_active',
        cellId: current.cellId,
        state: current.state,
      };
    }
    const retained = getFirstClaimableRetainedCell(args.threadId);
    if (retained !== undefined) {
      return {
        ok: false,
        reasonCode: 'cell_result_unclaimed',
        cellId: retained.cellId,
        state: retained.state,
      };
    }

    const cellId = createCellId();
    activeCellsByThread.set(args.threadId, {
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
    const current = activeCellsByThread.get(args.threadId);
    if (!isMatchingCell(current, args.cellId)) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state !== 'admitting') {
      return { ok: true, value: { released: false } };
    }
    activeCellsByThread.delete(args.threadId);
    bumpRevision(args.threadId);
    return { ok: true, value: { released: true } };
  }

  function promoteAdmittedCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    resources: PtcExecuteCodeCellResources;
  }): CellLookupResult<{ state: 'running' }> {
    const current = activeCellsByThread.get(args.threadId);
    if (
      !isMatchingCell(current, args.cellId) ||
      current.state !== 'admitting'
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
    activeCellsByThread.set(args.threadId, runningRecord);
    bumpRevision(args.threadId);
    return { ok: true, value: { state: 'running' } };
  }

  async function recordTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    result: PtcExecuteCodeCellTerminalResult;
  }): Promise<
    CellLookupResult<{ bridgeClosed: boolean; sessionTainted?: boolean }>
  > {
    const current = activeCellsByThread.get(args.threadId);
    if (!isMatchingCell(current, args.cellId)) {
      if (getRetainedTerminalCellRecord(args) !== undefined) {
        return { ok: true, value: { bridgeClosed: true } };
      }
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current.state === 'terminating' && current.reason === 'orphan_reap') {
      retainTerminalCellResultIfMissing({
        threadId: current.threadId,
        cellId: current.cellId,
        createdAtMs: current.createdAtMs,
        result: args.result,
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
    const latest = activeCellsByThread.get(args.threadId);
    if (!isMatchingCell(latest, args.cellId)) {
      if (getRetainedTerminalCellRecord(args) !== undefined) {
        return { ok: true, value: { bridgeClosed } };
      }
      return { ok: false, reasonCode: 'cell_missing' };
    }

    if (latest.state === 'terminating' && latest.reason === 'orphan_reap') {
      if (bridgeClosed) {
        retainTerminalCellResultIfMissing({
          threadId: latest.threadId,
          cellId: latest.cellId,
          createdAtMs: latest.createdAtMs,
          result: args.result,
        });
      } else {
        retainCellCleanupFailure({
          threadId: latest.threadId,
          cellId: latest.cellId,
          createdAtMs: latest.createdAtMs,
          terminalResult: args.result,
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
      activeCellsByThread.delete(args.threadId);
      const sessionTaintResult = await callBooleanWithoutThrow(
        () => latest.taintSession({ reason: 'run_terminal' }),
        'sessionTaint',
      );
      const sessionTainted = sessionTaintResult.ok;
      retainCellCleanupFailure({
        threadId: latest.threadId,
        cellId: latest.cellId,
        createdAtMs: latest.createdAtMs,
        terminalResult: args.result,
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
        },
      });
      bumpRevision(args.threadId);
      return { ok: true, value: { bridgeClosed: false, sessionTainted } };
    }

    clearRunningCellReapTimer(latest);
    activeCellsByThread.delete(args.threadId);
    retainTerminalCellResult({
      threadId: latest.threadId,
      cellId: latest.cellId,
      createdAtMs: latest.createdAtMs,
      result: args.result,
    });
    bumpRevision(args.threadId);

    return { ok: true, value: { bridgeClosed: true } };
  }

  function recordCellCleanupFailure(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    message: string;
    diagnostics: Record<string, string | number | boolean>;
    terminalResult?: PtcExecuteCodeCellTerminalResult;
  }): CellLookupResult<{ retained: boolean }> {
    const current = activeCellsByThread.get(args.threadId);
    if (current !== undefined && !isMatchingCell(current, args.cellId)) {
      return { ok: false, reasonCode: 'cell_missing' };
    }
    if (current !== undefined) {
      if (current.state === 'running' || current.state === 'terminating') {
        clearRunningCellReapTimer(current);
      }
      activeCellsByThread.delete(args.threadId);
    }
    retainCellCleanupFailure({
      threadId: args.threadId,
      cellId: args.cellId,
      createdAtMs: current?.createdAtMs ?? now(),
      ...(args.terminalResult !== undefined
        ? { terminalResult: args.terminalResult }
        : {}),
      message: args.message,
      diagnostics: args.diagnostics,
    });
    bumpRevision(args.threadId);
    return { ok: true, value: { retained: true } };
  }

  function readTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): TerminalCellLookupResult {
    return getTerminalCellResult(args);
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
    const current = activeCellsByThread.get(args.threadId);
    if (!isMatchingCell(current, args.cellId) || current.state !== 'running') {
      return { ok: false, reasonCode: 'cell_missing' };
    }

    return { ok: true, value: current.handle.drainNewOutput() };
  }

  function readRunningCellOutputRevision(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): CellLookupResult<{ outputRevision: number }> {
    const current = activeCellsByThread.get(args.threadId);
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
    const current = activeCellsByThread.get(args.threadId);
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
    const current = activeCellsByThread.get(args.threadId);
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
    const current = activeCellsByThread.get(args.threadId);
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
      activeCellsByThread.delete(args.threadId);
      bumpRevision(args.threadId);
      return { ok: true, status: 'admission_released' };
    }

    if (current.state === 'terminating') {
      return await current.closePromise;
    }

    const closePromise = closeRunningCell(current, args.reason);
    activeCellsByThread.set(args.threadId, {
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
    const activeSnapshot = [...activeCellsByThread.values()].map((cell) => ({
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
    const bridgeCloseResult = await callWithoutThrow(
      record.closeBridge,
      'callbackBridgeClose',
    );
    const sessionTaintResult = await callBooleanWithoutThrow(
      () => record.taintSession({ reason }),
      'sessionTaint',
    );
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
    };

    const current = activeCellsByThread.get(record.threadId);
    if (isMatchingCell(current, record.cellId)) {
      activeCellsByThread.delete(record.threadId);
      bumpRevision(record.threadId);
    }
    if (reason === 'orphan_reap') {
      retainOrphanReapTerminalResult({
        record,
        output,
        exit,
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
      ...(Object.keys(cleanupDiagnostics).length > 0
        ? { cleanupDiagnostics }
        : {}),
    };
  }

  function readCellState(args: {
    threadId: string;
  }): { cellId: PtcExecuteCodeCellId; state: PtcExecuteCodeCellState } | null {
    const current = activeCellsByThread.get(args.threadId);
    if (current !== undefined) {
      return { cellId: current.cellId, state: current.state };
    }
    const retainedIterator = retainedCellsByThread
      .get(args.threadId)
      ?.values()
      .next();
    const retained =
      retainedIterator?.done === false ? retainedIterator.value : undefined;
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
    return now() >= record.expiresAtMs;
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
    if (record.state === 'terminal_retained') {
      scheduleTerminalRetainedCellReap(record);
    }
    retainedByCellId.set(record.cellId, record);
    retainedCellsByThread.set(record.threadId, retainedByCellId);
  }

  function retainTerminalCellResult(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    result: PtcExecuteCodeCellTerminalResult;
  }): TerminalRetainedCellRecord {
    const completedAtMs = now();
    const record: TerminalRetainedCellRecord = {
      threadId: args.threadId,
      cellId: args.cellId,
      state: 'terminal_retained',
      createdAtMs: args.createdAtMs,
      completedAtMs,
      expiresAtMs: completedAtMs + terminalResultRetentionMs,
      result: args.result,
    };
    storeTerminalRetainedCell(record);
    return record;
  }

  function retainTerminalCellResultIfMissing(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    result: PtcExecuteCodeCellTerminalResult;
  }): TerminalRetainedCellRecord {
    return (
      getRetainedTerminalCellRecord(args) ?? retainTerminalCellResult(args)
    );
  }

  function retainOrphanReapTerminalResult(args: {
    record: RunningCellRecord;
    output: DetachedProcessOutputSegment;
    exit: DetachedProcessExitInfo;
    cleanupDiagnostics: Record<string, string | number | boolean>;
  }): void {
    const terminalResult = getRetainedTerminalResult(args.record) ?? {
      status: 'terminated',
      output: args.output,
      exit: args.exit,
    };
    if (Object.keys(args.cleanupDiagnostics).length > 0) {
      retainCellCleanupFailure({
        threadId: args.record.threadId,
        cellId: args.record.cellId,
        createdAtMs: args.record.createdAtMs,
        terminalResult,
        message: 'PTC execute_code cell orphan reaper cleanup failed',
        diagnostics: args.cleanupDiagnostics,
      });
      return;
    }
    retainTerminalCellResultIfMissing({
      threadId: args.record.threadId,
      cellId: args.record.cellId,
      createdAtMs: args.record.createdAtMs,
      result: terminalResult,
    });
  }

  function retainCellCleanupFailure(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    createdAtMs: number;
    message: string;
    diagnostics: Record<string, string | number | boolean>;
    terminalResult?: PtcExecuteCodeCellTerminalResult;
  }): void {
    const completedAtMs = now();
    storeTerminalRetainedCell({
      threadId: args.threadId,
      cellId: args.cellId,
      state: 'terminal_retained',
      createdAtMs: args.createdAtMs,
      completedAtMs,
      expiresAtMs: completedAtMs + terminalResultRetentionMs,
      result: {
        status: 'cleanup_failed',
        message: args.message,
        diagnostics: args.diagnostics,
        ...(args.terminalResult !== undefined
          ? { terminalResult: args.terminalResult }
          : {}),
      },
    });
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
    promoteAdmittedCell,
    recordTerminalCellResult,
    recordCellCleanupFailure,
    readTerminalCellResult,
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
    clearReapTimeout(record.orphanReapTimer);
    record.orphanReapTimer = undefined;
  }

  function scheduleTerminalRetainedCellReap(
    record: TerminalRetainedCellRecord,
  ): void {
    const delayMs = Math.max(1, record.expiresAtMs - now());
    record.retentionReapTimer = scheduleReapTimeout(async () => {
      const current = retainedCellsByThread
        .get(record.threadId)
        ?.get(record.cellId);
      if (current !== record || current.state !== 'terminal_retained') {
        return;
      }
      current.retentionReapTimer = undefined;
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
    clearReapTimeout(record.retentionReapTimer);
    record.retentionReapTimer = undefined;
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
): unknown {
  const timer = setTimeout(() => {
    void callback();
  }, delayMs);
  timer.unref?.();
  return timer;
}

function clearDefaultReapTimeout(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
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
