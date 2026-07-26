import { createLogger } from '@geulbat/structured-logger/logger';
import type { RunId, ThreadId } from '../contract.js';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  ChildRunSnapshot,
  ChildRunStatus,
  ChildRunTerminalSnapshot,
  SubagentCapability,
  SubagentRuntimeDiagnostics,
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
    capabilities?: readonly SubagentCapability[];
    modelPin: ChildRunSnapshot['modelPin'];
    subagentModelRouting: ChildRunSnapshot['subagentModelRouting'];
    runtime?: SubagentRuntimeDiagnostics;
  }): void;
  markChildApprovalPending(childRunId: RunId): void;
  markChildRunning(childRunId: RunId): void;
  updateChildRuntime(args: {
    childRunId: RunId;
    runtime: SubagentRuntimeDiagnostics;
  }): ChildRunSnapshot | undefined;
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
  getActiveChildRuns(): ChildRunSnapshot[];
  getActiveChildRunsByOwnerThread(ownerThreadId: ThreadId): ChildRunSnapshot[];
  subscribeActiveChildRunUpdates(
    ownerThreadId: ThreadId,
    listener: (snapshot: ChildRunSnapshot) => void,
  ): () => void;
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

function cloneRuntimeDiagnostics(
  runtime: SubagentRuntimeDiagnostics,
): SubagentRuntimeDiagnostics {
  return {
    ...runtime,
    ...(runtime.lastTool === undefined
      ? {}
      : { lastTool: { ...runtime.lastTool } }),
    ...(runtime.providerRequest === undefined
      ? {}
      : {
          providerRequest: {
            ...runtime.providerRequest,
            ...(runtime.providerRequest.retry === undefined
              ? {}
              : { retry: { ...runtime.providerRequest.retry } }),
          },
        }),
  };
}

function hasSameProviderRequestDiagnostics(
  current: SubagentRuntimeDiagnostics['providerRequest'],
  next: SubagentRuntimeDiagnostics['providerRequest'],
): boolean {
  if (current === undefined || next === undefined) {
    return current === next;
  }
  return (
    current.startedAt === next.startedAt &&
    current.lastEventAt === next.lastEventAt &&
    current.endedAt === next.endedAt &&
    current.durationMs === next.durationMs &&
    current.attemptCount === next.attemptCount &&
    current.retry?.available === next.retry?.available &&
    current.retry?.performed === next.retry?.performed &&
    current.retry?.outcome === next.retry?.outcome
  );
}

function cloneSnapshot(snapshot: ChildRunSnapshot): ChildRunSnapshot {
  return {
    ...snapshot,
    ...(snapshot.capabilities === undefined
      ? {}
      : { capabilities: [...snapshot.capabilities] }),
    runtime: cloneRuntimeDiagnostics(snapshot.runtime),
    modelPin: {
      ...snapshot.modelPin,
      providerRunSelection: {
        providerModel: {
          ...snapshot.modelPin.providerRunSelection.providerModel,
        },
        reasoningEffort: snapshot.modelPin.providerRunSelection.reasoningEffort,
        ...(snapshot.modelPin.providerRunSelection.serviceTier === undefined
          ? {}
          : {
              serviceTier: snapshot.modelPin.providerRunSelection.serviceTier,
            }),
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
  const activeChildRunUpdates = createSignal<[ChildRunSnapshot]>({
    onListenerError(error) {
      logger.warn('active child listener failed:', error);
    },
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

  function readActiveChildRuns(ownerThreadId?: ThreadId): ChildRunSnapshot[] {
    return [...records.values()]
      .filter(
        (record) =>
          !isTerminalSnapshot(record) &&
          (ownerThreadId === undefined ||
            record.ownerThreadId === ownerThreadId),
      )
      .map(cloneSnapshot);
  }

  return {
    registerChildRun(args) {
      const now = new Date().toISOString();
      const runtime: SubagentRuntimeDiagnostics = args.runtime ?? {
        phase: 'provider_waiting',
        observedAt: now,
        partialOutputAvailable: false,
      };
      const snapshot: ChildRunSnapshot = {
        childRunId: args.childRunId,
        childThreadId: args.childThreadId,
        parentRunId: args.parentRunId,
        ownerThreadId: args.ownerThreadId,
        subagentType: args.subagentType,
        ...(args.capabilities === undefined || args.capabilities.length === 0
          ? {}
          : { capabilities: [...args.capabilities] }),
        modelPin: args.modelPin,
        subagentModelRouting: args.subagentModelRouting,
        runtime: cloneRuntimeDiagnostics(runtime),
        status: 'running',
        result: null,
        completedAt: null,
        reason: null,
        updatedAt: now,
      };
      records.set(args.childRunId, cloneSnapshot(snapshot));
      revisionTracker.bumpRevision();
      activeChildRunUpdates.emit(cloneSnapshot(snapshot));
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
    updateChildRuntime({ childRunId, runtime }) {
      const current = records.get(childRunId);
      if (current === undefined || isTerminalSnapshot(current)) {
        return current === undefined ? undefined : cloneSnapshot(current);
      }
      const currentLastTool = current.runtime.lastTool;
      const nextLastTool = runtime.lastTool;
      if (
        current.runtime.phase === runtime.phase &&
        current.runtime.observedAt === runtime.observedAt &&
        current.runtime.partialOutputAvailable ===
          runtime.partialOutputAvailable &&
        current.runtime.previousChildRunId === runtime.previousChildRunId &&
        hasSameProviderRequestDiagnostics(
          current.runtime.providerRequest,
          runtime.providerRequest,
        ) &&
        currentLastTool?.name === nextLastTool?.name &&
        currentLastTool?.callId === nextLastTool?.callId &&
        currentLastTool?.state === nextLastTool?.state
      ) {
        return cloneSnapshot(current);
      }
      const next: ChildRunSnapshot = {
        ...current,
        runtime: cloneRuntimeDiagnostics(runtime),
        updatedAt: runtime.observedAt,
      };
      records.set(childRunId, next);
      revisionTracker.bumpRevision();
      activeChildRunUpdates.emit(cloneSnapshot(next));
      return cloneSnapshot(next);
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
    getActiveChildRuns() {
      return readActiveChildRuns();
    },
    getActiveChildRunsByOwnerThread(ownerThreadId) {
      return readActiveChildRuns(ownerThreadId);
    },
    subscribeActiveChildRunUpdates(ownerThreadId, listener) {
      return activeChildRunUpdates.subscribe((snapshot) => {
        if (
          snapshot.ownerThreadId === ownerThreadId &&
          !isTerminalSnapshot(snapshot)
        ) {
          listener(cloneSnapshot(snapshot));
        }
      });
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
