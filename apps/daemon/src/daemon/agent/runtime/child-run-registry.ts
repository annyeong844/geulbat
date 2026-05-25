import { createLogger } from '@geulbat/shared-utils/logger';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  ChildRunSnapshot,
  ChildRunStatus,
  ChildRunTerminalSnapshot,
  SubagentType,
} from '../../subagent-runtime-contracts.js';
import { isAgentChildTerminalState } from '../../subagent-runtime-contracts.js';
import { createSignal } from '../../utils/signal.js';

export interface ChildRunRegistry {
  registerChildRun(args: {
    childRunId: RunId;
    childThreadId: ThreadId;
    parentRunId: RunId;
    ownerThreadId: ThreadId;
    subagentType: SubagentType;
  }): void;
  markChildApprovalPending(childRunId: RunId): void;
  markChildRunning(childRunId: RunId): void;
  markChildTerminal(args: {
    childRunId: RunId;
    terminalState: AgentChildTerminalState;
    result: string;
    reason?: AgentChildTerminalReason | null;
  }): void;
  getChildRun(childRunId: RunId): ChildRunSnapshot | undefined;
  getChildRuns(childRunIds: readonly RunId[]): {
    revision: number;
    records: ChildRunSnapshot[];
  };
  waitForRevisionChange(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

const logger = createLogger('child-run-registry');
const CHILD_RUN_RETENTION_TTL_MS = 5 * 60 * 1000;
const MAX_RETAINED_TERMINAL_CHILD_RUNS = 16;

interface ChildRunRevisionTracker {
  getRevision(): number;
  bumpRevision(): void;
  waitForRevisionChange(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

interface ChildRunRetentionController {
  clearRetentionTimer(childRunId: RunId): void;
  scheduleRetentionCollection(childRunId: RunId): void;
  enforceTerminalBudget(): void;
}

function cloneSnapshot(snapshot: ChildRunSnapshot): ChildRunSnapshot {
  return { ...snapshot };
}

function isTerminalStatus(
  status: ChildRunStatus,
): status is AgentChildTerminalState {
  return isAgentChildTerminalState(status);
}

function isTerminalSnapshot(
  snapshot: ChildRunSnapshot,
): snapshot is ChildRunTerminalSnapshot {
  return isTerminalStatus(snapshot.status);
}

function createChildRunRevisionTracker(): ChildRunRevisionTracker {
  let revision = 0;
  const signal = createSignal<[number]>({
    onListenerError(error) {
      logger.warn('listener failed:', error);
    },
  });

  function bumpRevision(): void {
    revision += 1;
    signal.emit(revision);
  }

  return {
    getRevision() {
      return revision;
    },
    bumpRevision,
    waitForRevisionChange(afterRevision, abortSignal) {
      if (revision !== afterRevision) {
        return Promise.resolve(revision);
      }

      return new Promise<number>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};

        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          unsubscribe();
          abortSignal?.removeEventListener('abort', onAbort);
          fn();
        };

        const onAbort = () => {
          finish(() => reject(new Error('child wait aborted')));
        };

        unsubscribe = signal.subscribe((nextRevision) => {
          if (nextRevision === afterRevision) {
            return;
          }
          finish(() => resolve(nextRevision));
        });

        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

function createChildRunRetentionController(args: {
  records: Map<RunId, ChildRunSnapshot>;
  retentionTtlMs: number;
  maxRetainedTerminalRuns: number;
  bumpRevision: () => void;
}): ChildRunRetentionController {
  const { records, retentionTtlMs, maxRetainedTerminalRuns, bumpRevision } =
    args;
  const retentionTimers = new Map<RunId, ReturnType<typeof setTimeout>>();

  function clearRetentionTimer(childRunId: RunId): void {
    const timer = retentionTimers.get(childRunId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    retentionTimers.delete(childRunId);
  }

  function collectTerminalRecord(
    childRunId: RunId,
    reason: 'retention_ttl' | 'memory_budget',
  ): void {
    const current = records.get(childRunId);
    if (!current || !isTerminalSnapshot(current)) {
      return;
    }
    clearRetentionTimer(childRunId);
    records.delete(childRunId);
    logger.warn('collected retained child run record', {
      childRunId,
      reason,
    });
    bumpRevision();
  }

  return {
    clearRetentionTimer,
    scheduleRetentionCollection(childRunId) {
      clearRetentionTimer(childRunId);
      const timer = setTimeout(() => {
        collectTerminalRecord(childRunId, 'retention_ttl');
      }, retentionTtlMs);
      timer.unref?.();
      retentionTimers.set(childRunId, timer);
    },
    enforceTerminalBudget() {
      const terminalRecords = [...records.values()]
        .filter(isTerminalSnapshot)
        .sort((left, right) => {
          const leftCompletedAt = Date.parse(left.completedAt);
          const rightCompletedAt = Date.parse(right.completedAt);
          return leftCompletedAt - rightCompletedAt;
        });

      while (terminalRecords.length > maxRetainedTerminalRuns) {
        const oldest = terminalRecords.shift();
        if (!oldest) {
          break;
        }
        collectTerminalRecord(oldest.childRunId, 'memory_budget');
      }
    },
  };
}

export function createChildRunRegistry(
  options: {
    retentionTtlMs?: number;
    maxRetainedTerminalRuns?: number;
  } = {},
): ChildRunRegistry {
  const records = new Map<RunId, ChildRunSnapshot>();
  const revisionTracker = createChildRunRevisionTracker();
  const retentionTtlMs = options.retentionTtlMs ?? CHILD_RUN_RETENTION_TTL_MS;
  const maxRetainedTerminalRuns =
    options.maxRetainedTerminalRuns ?? MAX_RETAINED_TERMINAL_CHILD_RUNS;
  const retention = createChildRunRetentionController({
    records,
    retentionTtlMs,
    maxRetainedTerminalRuns,
    bumpRevision: () => revisionTracker.bumpRevision(),
  });

  function mutateRecord(
    childRunId: RunId,
    mutate: (current: ChildRunSnapshot) => ChildRunSnapshot,
  ): void {
    const current = records.get(childRunId);
    if (!current) {
      return;
    }
    const next = mutate(current);
    if (next === current) {
      return;
    }
    records.set(childRunId, next);
    revisionTracker.bumpRevision();
  }

  return {
    registerChildRun(args) {
      const now = new Date().toISOString();
      retention.clearRetentionTimer(args.childRunId);
      records.set(args.childRunId, {
        childRunId: args.childRunId,
        childThreadId: args.childThreadId,
        parentRunId: args.parentRunId,
        ownerThreadId: args.ownerThreadId,
        subagentType: args.subagentType,
        status: 'running',
        result: null,
        completedAt: null,
        reason: null,
        updatedAt: now,
      });
      revisionTracker.bumpRevision();
    },
    markChildApprovalPending(childRunId) {
      mutateRecord(childRunId, (current) => {
        if (
          current.status === 'approval_pending' ||
          isTerminalSnapshot(current)
        ) {
          return current;
        }
        return {
          ...current,
          status: 'approval_pending',
          result: null,
          completedAt: null,
          reason: null,
          updatedAt: new Date().toISOString(),
        };
      });
    },
    markChildRunning(childRunId) {
      mutateRecord(childRunId, (current) => {
        if (current.status === 'running' || isTerminalSnapshot(current)) {
          return current;
        }
        return {
          ...current,
          status: 'running',
          result: null,
          completedAt: null,
          reason: null,
          updatedAt: new Date().toISOString(),
        };
      });
    },
    markChildTerminal({ childRunId, terminalState, result, reason }) {
      const current = records.get(childRunId);
      if (!current) {
        return;
      }
      const nextReason = reason ?? null;
      if (
        current.status === terminalState &&
        current.result === result &&
        current.reason === nextReason &&
        current.completedAt !== null
      ) {
        return;
      }
      records.set(childRunId, {
        ...current,
        status: terminalState,
        result,
        completedAt: new Date().toISOString(),
        reason: nextReason,
        updatedAt: new Date().toISOString(),
      });
      revisionTracker.bumpRevision();
      retention.scheduleRetentionCollection(childRunId);
      retention.enforceTerminalBudget();
    },
    getChildRun(childRunId) {
      const snapshot = records.get(childRunId);
      return snapshot ? cloneSnapshot(snapshot) : undefined;
    },
    getChildRuns(childRunIds) {
      return {
        revision: revisionTracker.getRevision(),
        records: childRunIds
          .map((childRunId) => records.get(childRunId))
          .filter((record): record is ChildRunSnapshot => record !== undefined)
          .map(cloneSnapshot),
      };
    },
    waitForRevisionChange(afterRevision, abortSignal) {
      return revisionTracker.waitForRevisionChange(afterRevision, abortSignal);
    },
  };
}
