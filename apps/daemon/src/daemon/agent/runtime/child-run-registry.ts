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

export type WaitLeaseId = number & { readonly __brand: 'WaitLeaseId' };
export type ChildRunCollectedReason = 'retention_ttl' | 'memory_budget';

export type AcquireWaitLeaseResult =
  | { ok: true; leaseId: WaitLeaseId }
  | { ok: false; message: string };

export interface CollectedChildRunSnapshot {
  childRunId: RunId;
  ownerThreadId: ThreadId;
  collectedReason: ChildRunCollectedReason;
  collectedAt: string;
}

export interface ChildRunRegistry {
  registerChildRun(args: {
    childRunId: RunId;
    childThreadId: ThreadId;
    parentRunId: RunId;
    ownerThreadId: ThreadId;
    subagentType: SubagentType;
  }): void;
  /**
   * Register an owner-scoped active wait lease over the given child ids and pin
   * their terminal records against budget/TTL collection until the owning waiter
   * hands each off (ack) or releases the lease. Validation runs before any pin is
   * installed: unknown ids or ids owned by another thread fail the whole acquire
   * with no pin created.
   */
  acquireWaitLease(args: {
    ownerThreadId: ThreadId;
    childRunIds: readonly RunId[];
  }): AcquireWaitLeaseResult;
  /** Release this lease's claim on one child; the child unpins once no lease claims it. */
  ackWaiterHandoff(leaseId: WaitLeaseId, childRunId: RunId): void;
  /** Release all remaining claims held by this lease. Idempotent / safe for unknown ids. */
  releaseWaitLease(leaseId: WaitLeaseId): void;
  markChildApprovalPending(childRunId: RunId): void;
  markChildRunning(childRunId: RunId): void;
  markChildTerminal(args: {
    childRunId: RunId;
    terminalState: AgentChildTerminalState;
    result: string;
    reason?: AgentChildTerminalReason | null;
  }): void;
  getChildRun(childRunId: RunId): ChildRunSnapshot | undefined;
  getCollectedChildRun(
    childRunId: RunId,
  ): CollectedChildRunSnapshot | undefined;
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
const MAX_COLLECTED_CHILD_RUN_TOMBSTONES = 256;

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
  /** Re-run deferred collection for a record that just lost its last wait-lease pin. */
  onChildUnpinned(childRunId: RunId): void;
}

function cloneSnapshot(snapshot: ChildRunSnapshot): ChildRunSnapshot {
  return { ...snapshot };
}

function cloneCollectedSnapshot(
  snapshot: CollectedChildRunSnapshot,
): CollectedChildRunSnapshot {
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
  isPinned: (childRunId: RunId) => boolean;
  rememberCollectedChildRun: (snapshot: CollectedChildRunSnapshot) => void;
}): ChildRunRetentionController {
  const {
    records,
    retentionTtlMs,
    maxRetainedTerminalRuns,
    bumpRevision,
    isPinned,
    rememberCollectedChildRun,
  } = args;
  const retentionTimers = new Map<RunId, ReturnType<typeof setTimeout>>();
  // Records whose TTL elapsed while pinned by an active wait lease; collected
  // once the record loses its last pin (deferred TTL collection).
  const retentionDue = new Set<RunId>();

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
    // An active wait lease still references this record: do not drop it out from
    // under the waiter. Mark it retention-due and collect once it unpins.
    if (isPinned(childRunId)) {
      retentionDue.add(childRunId);
      return;
    }
    clearRetentionTimer(childRunId);
    retentionDue.delete(childRunId);
    rememberCollectedChildRun({
      childRunId,
      ownerThreadId: current.ownerThreadId,
      collectedReason: reason,
      collectedAt: new Date().toISOString(),
    });
    records.delete(childRunId);
    logger.warn('collected retained child run record', {
      childRunId,
      reason,
    });
    bumpRevision();
  }

  function enforceTerminalBudget(): void {
    const terminalRecords = [...records.values()]
      .filter(isTerminalSnapshot)
      .sort((left, right) => {
        const leftCompletedAt = Date.parse(left.completedAt);
        const rightCompletedAt = Date.parse(right.completedAt);
        return leftCompletedAt - rightCompletedAt;
      });

    // Pinned records stay (they count toward retained, so the budget may be
    // transiently exceeded), and the oldest UNPINNED records are evicted.
    let retained = terminalRecords.length;
    for (const record of terminalRecords) {
      if (retained <= maxRetainedTerminalRuns) {
        break;
      }
      if (isPinned(record.childRunId)) {
        continue;
      }
      collectTerminalRecord(record.childRunId, 'memory_budget');
      retained -= 1;
    }
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
    enforceTerminalBudget,
    onChildUnpinned(childRunId) {
      // TTL elapsed while pinned -> collect now that the last pin is gone.
      if (retentionDue.has(childRunId)) {
        collectTerminalRecord(childRunId, 'retention_ttl');
      }
      // The newly unpinned record may also have pushed the budget over; sweep.
      enforceTerminalBudget();
    },
  };
}

export function createChildRunRegistry(
  options: {
    retentionTtlMs?: number;
    maxRetainedTerminalRuns?: number;
    maxCollectedChildRunTombstones?: number;
  } = {},
): ChildRunRegistry {
  const records = new Map<RunId, ChildRunSnapshot>();
  const collectedRecords = new Map<RunId, CollectedChildRunSnapshot>();
  const revisionTracker = createChildRunRevisionTracker();
  const retentionTtlMs = options.retentionTtlMs ?? CHILD_RUN_RETENTION_TTL_MS;
  const maxRetainedTerminalRuns =
    options.maxRetainedTerminalRuns ?? MAX_RETAINED_TERMINAL_CHILD_RUNS;
  const maxCollectedChildRunTombstones =
    options.maxCollectedChildRunTombstones ??
    MAX_COLLECTED_CHILD_RUN_TOMBSTONES;

  function rememberCollectedChildRun(
    snapshot: CollectedChildRunSnapshot,
  ): void {
    collectedRecords.set(snapshot.childRunId, snapshot);
    while (collectedRecords.size > maxCollectedChildRunTombstones) {
      const oldestChildRunId = collectedRecords.keys().next().value;
      if (oldestChildRunId === undefined) {
        return;
      }
      collectedRecords.delete(oldestChildRunId);
    }
  }

  // Active wait-lease bookkeeping (lease-scoped pins, §7.2). A child stays pinned
  // (exempt from budget/TTL eviction) while any lease still holds a claim on it.
  let nextLeaseId = 1;
  const leaseTargets = new Map<WaitLeaseId, Set<RunId>>();
  const pinsByChildId = new Map<RunId, Set<WaitLeaseId>>();
  function isPinned(childRunId: RunId): boolean {
    const pins = pinsByChildId.get(childRunId);
    return pins !== undefined && pins.size > 0;
  }
  function dropLeaseClaim(leaseId: WaitLeaseId, childRunId: RunId): void {
    const pins = pinsByChildId.get(childRunId);
    if (!pins) {
      return;
    }
    pins.delete(leaseId);
    if (pins.size === 0) {
      pinsByChildId.delete(childRunId);
      retention.onChildUnpinned(childRunId);
    }
  }

  const retention = createChildRunRetentionController({
    records,
    retentionTtlMs,
    maxRetainedTerminalRuns,
    bumpRevision: () => revisionTracker.bumpRevision(),
    isPinned,
    rememberCollectedChildRun,
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
      collectedRecords.delete(args.childRunId);
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
    getCollectedChildRun(childRunId) {
      const snapshot = collectedRecords.get(childRunId);
      return snapshot ? cloneCollectedSnapshot(snapshot) : undefined;
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
    acquireWaitLease({ ownerThreadId, childRunIds }) {
      // Validate every target before installing any pin (§7.2.1): unknown ids or
      // ids owned by another thread fail the whole acquire with no pin created.
      for (const childRunId of childRunIds) {
        const record = records.get(childRunId);
        if (!record) {
          return { ok: false, message: `unknown child run: ${childRunId}` };
        }
        if (record.ownerThreadId !== ownerThreadId) {
          return {
            ok: false,
            message: `child run does not belong to current owner thread: ${childRunId}`,
          };
        }
      }
      const leaseId = nextLeaseId as WaitLeaseId;
      nextLeaseId += 1;
      const targets = new Set<RunId>();
      for (const childRunId of childRunIds) {
        targets.add(childRunId);
        let pins = pinsByChildId.get(childRunId);
        if (!pins) {
          pins = new Set<WaitLeaseId>();
          pinsByChildId.set(childRunId, pins);
        }
        pins.add(leaseId);
      }
      leaseTargets.set(leaseId, targets);
      return { ok: true, leaseId };
    },
    ackWaiterHandoff(leaseId, childRunId) {
      const targets = leaseTargets.get(leaseId);
      if (!targets || !targets.has(childRunId)) {
        return;
      }
      targets.delete(childRunId);
      dropLeaseClaim(leaseId, childRunId);
      if (targets.size === 0) {
        leaseTargets.delete(leaseId);
      }
    },
    releaseWaitLease(leaseId) {
      const targets = leaseTargets.get(leaseId);
      if (!targets) {
        return;
      }
      for (const childRunId of [...targets]) {
        dropLeaseClaim(leaseId, childRunId);
      }
      leaseTargets.delete(leaseId);
    },
  };
}
