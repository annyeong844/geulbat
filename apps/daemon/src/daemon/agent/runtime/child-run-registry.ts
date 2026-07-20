import { createLogger } from '@geulbat/structured-logger/logger';
import type { RunId, ThreadId } from '../contract.js';
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
    modelPin: ChildRunSnapshot['modelPin'];
    subagentModelRouting: ChildRunSnapshot['subagentModelRouting'];
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
  claimTerminalChildRuns(args: {
    ownerThreadId: ThreadId;
    childRunIds: readonly RunId[];
  }): number;
  waitForRevisionChange(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

const logger = createLogger('child-run-registry');

interface ChildRunRevisionTracker {
  getRevision(): number;
  bumpRevision(): void;
  waitForRevisionChange(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

function cloneSnapshot(snapshot: ChildRunSnapshot): ChildRunSnapshot {
  return {
    ...snapshot,
    modelPin: {
      ...snapshot.modelPin,
      providerRunSelection: {
        providerModel: {
          ...snapshot.modelPin.providerRunSelection.providerModel,
        },
        reasoningEffort: snapshot.modelPin.providerRunSelection.reasoningEffort,
      },
    },
    subagentModelRouting:
      snapshot.subagentModelRouting.mode === 'auto'
        ? { mode: 'auto' }
        : {
            mode: 'fixed',
            choice: { ...snapshot.subagentModelRouting.choice },
          },
  };
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

export function createChildRunRegistry(): ChildRunRegistry {
  const records = new Map<RunId, ChildRunSnapshot>();
  const revisionTracker = createChildRunRevisionTracker();

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
      const snapshot: ChildRunSnapshot = {
        childRunId: args.childRunId,
        childThreadId: args.childThreadId,
        parentRunId: args.parentRunId,
        ownerThreadId: args.ownerThreadId,
        subagentType: args.subagentType,
        modelPin: args.modelPin,
        subagentModelRouting: args.subagentModelRouting,
        status: 'running',
        result: null,
        completedAt: null,
        reason: null,
        updatedAt: now,
      };
      records.set(args.childRunId, cloneSnapshot(snapshot));
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
    claimTerminalChildRuns({ ownerThreadId, childRunIds }) {
      let claimed = 0;
      for (const childRunId of childRunIds) {
        const current = records.get(childRunId);
        if (
          current === undefined ||
          current.ownerThreadId !== ownerThreadId ||
          !isTerminalSnapshot(current)
        ) {
          continue;
        }
        records.delete(childRunId);
        claimed += 1;
      }
      if (claimed > 0) {
        revisionTracker.bumpRevision();
      }
      return claimed;
    },
    waitForRevisionChange(afterRevision, abortSignal) {
      return revisionTracker.waitForRevisionChange(afterRevision, abortSignal);
    },
  };
}
