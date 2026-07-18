// PTC execute_code 터미널 결과 보존 스토어 — 셀이 종료된 뒤의 결과 레코드
// 계보를 소유한다: 메모리 보존(retained) → 만료(expired) 전이, durable
// persistence 직렬화(셀 단위 in-flight 체인), 보존 만료 reap 타이머.
// 활성 셀 상태 머신은 cell-registry가 소유하고, 여기는 terminal 이후만
// 담당한다. 변경 알림은 registry의 bumpRevision을 주입받아 쏜다 —
// 형제 의존이 runtime-contract/shared 타입뿐인 leaf 모듈(순환 없음).
import type {
  DetachedProcessExitInfo,
  DetachedProcessOutputSegment,
} from '../../shared/process-command.js';
import type {
  PtcExecuteCodeCellDurableOutput,
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeResult,
  PtcExecuteCodeRuntimeStoreSummary,
  PtcExecuteCodeStoreError,
} from './execute-code-runtime-contract.js';

export const PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_MEMORY_RETENTION_DEFAULT_MS = 300_000;

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

export type PersistPtcExecuteCodeCellTerminalResult = (args: {
  stateRoot: string;
  threadId: string;
  cellId: PtcExecuteCodeCellId;
  result: PtcExecuteCodeCellRetainedResult;
}) => Promise<PtcExecuteCodeCellDurableOutput | undefined>;

export type PtcExecuteCodeCellReapCallback = () => Promise<void>;

export type PtcExecuteCodeCellReapCancel = () => void;

export type TerminalCellLookupResult =
  | { ok: true; value: PtcExecuteCodeCellRetainedResult }
  | { ok: false; reasonCode: 'cell_missing' | 'cell_expired' };

export interface BaseCellRecord {
  threadId: string;
  cellId: PtcExecuteCodeCellId;
  createdAtMs: number;
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

// 활성 셀 레코드 대신 스토어가 실제로 읽는 4개 필드만 — 스토어가
// running/terminating 레코드 타입(registry 소유)에 의존하지 않게 한다.
interface PtcExecuteCodeTerminalCellOrigin {
  threadId: string;
  cellId: PtcExecuteCodeCellId;
  createdAtMs: number;
  terminalResultStateRoot?: string;
}

export function createPtcExecuteCodeCellTerminalRetentionStore(options: {
  now: () => number;
  terminalResultMemoryRetentionMs: number;
  scheduleReapTimeout: (
    callback: PtcExecuteCodeCellReapCallback,
    delayMs: number,
  ) => PtcExecuteCodeCellReapCancel;
  persistTerminalResult?: PersistPtcExecuteCodeCellTerminalResult;
  // registry의 변경 신호 — 만료 정리로 상태가 바뀔 때 구독자를 깨운다
  bumpRevision: (threadId?: string) => void;
}) {
  const {
    now,
    terminalResultMemoryRetentionMs,
    scheduleReapTimeout,
    persistTerminalResult,
    bumpRevision,
  } = options;
  const retainedCellsByThread = new Map<
    string,
    Map<PtcExecuteCodeCellId, TerminalCellRecord>
  >();
  const terminalResultPersistenceByCell = new Map<string, Promise<void>>();

  function hasRetainedCells(threadId: string): boolean {
    return (retainedCellsByThread.get(threadId)?.size ?? 0) > 0;
  }

  // 만료 부수효과 없는 원시 조회 — close/readCellState의 분기용
  function peekTerminalCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): TerminalCellRecord | undefined {
    return retainedCellsByThread.get(args.threadId)?.get(args.cellId);
  }

  function peekFirstTerminalCell(
    threadId: string,
  ): TerminalCellRecord | undefined {
    return retainedCellsByThread.get(threadId)?.values().next().value;
  }

  function readAllTerminalCells(): TerminalCellRecord[] {
    return [...retainedCellsByThread.values()].flatMap((retainedByCellId) => [
      ...retainedByCellId.values(),
    ]);
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
    record: PtcExecuteCodeTerminalCellOrigin;
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

  return {
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
  };
}
