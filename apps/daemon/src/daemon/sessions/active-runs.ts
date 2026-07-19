import {
  type RunId,
  type ThreadId,
  assertSessionRunId as assertValidRunId,
  assertSessionThreadId as assertValidThreadId,
} from './contract.js';
import type { RunContext } from '../run-context.js';
import {
  pushPendingInterject,
  removePendingInterjectBySeq,
  requestInterjectFlush,
  type RunInterjectBuffer,
} from './active-run-interject-buffer.js';

export interface ActiveRun extends RunContext {
  runId: RunId;
  ownerThreadId: ThreadId;
  abortController: AbortController;
  interject: RunInterjectBuffer;
  startedAt: string;
  parentRunId?: RunId;
}

interface ActiveRunSnapshot extends Omit<RunContext, 'stateRoot'> {
  runId: RunId;
  ownerThreadId: ThreadId;
  startedAt: string;
  parentRunId?: RunId;
  aborted: boolean;
}

export interface ActiveRunStore {
  tryStartRun(
    threadId: string | ThreadId,
    run: ActiveRun,
  ): { ok: true } | { ok: false; activeRunId: RunId };
  finishRun(threadId: string | ThreadId, runId: RunId): void;
  getRunById(runId: RunId): ActiveRunSnapshot | undefined;
  getRunByThreadId(threadId: string): ActiveRunSnapshot | undefined;
  appendPendingInterject(
    runId: RunId,
    request: { text: string },
  ):
    | { ok: true; receivedSeq: number; bufferDepth: number }
    | { ok: false; code: 'not_found' };
  cancelPendingInterject(
    runId: RunId,
    receivedSeq: number,
  ): { ok: true; cancelled: boolean } | { ok: false; code: 'not_found' };
  requestPendingInterjectFlush(
    runId: RunId,
  ): { ok: true; flushed: boolean } | { ok: false; code: 'not_found' };
  abortRun(runId: RunId): boolean;
  abortRunSubtree(runId: RunId, reason?: unknown): boolean;
  abortThreadTree(ownerThreadId: string): boolean;
}

function snapshotActiveRun(run: ActiveRun): ActiveRunSnapshot {
  return {
    runId: run.runId,
    threadId: run.threadId,
    workingDirectory: run.workingDirectory,
    ownerThreadId: run.ownerThreadId,
    startedAt: run.startedAt,
    aborted: run.abortController.signal.aborted,
    ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
  };
}

export function createActiveRunStore(): ActiveRunStore {
  const byThread = new Map<ThreadId, ActiveRun>();
  const byRunId = new Map<RunId, ActiveRun>();
  const runIdsByOwnerThread = new Map<ThreadId, Set<RunId>>();
  const ownerThreadIdByRunId = new Map<RunId, ThreadId>();
  const parentRunIdByRunId = new Map<RunId, RunId>();
  const childrenByParentRunId = new Map<RunId, Set<RunId>>();

  const pruneInactiveRunLineage = (runId: RunId): void => {
    if (byRunId.has(runId)) {
      return;
    }

    const children = childrenByParentRunId.get(runId);
    if (children && children.size > 0) {
      return;
    }
    childrenByParentRunId.delete(runId);

    const ownerThreadId = ownerThreadIdByRunId.get(runId);
    if (ownerThreadId !== undefined) {
      const ownerRuns = runIdsByOwnerThread.get(ownerThreadId);
      ownerRuns?.delete(runId);
      if (ownerRuns?.size === 0) {
        runIdsByOwnerThread.delete(ownerThreadId);
      }
      ownerThreadIdByRunId.delete(runId);
    }

    const parentRunId = parentRunIdByRunId.get(runId);
    if (parentRunId === undefined) {
      return;
    }
    parentRunIdByRunId.delete(runId);

    const siblings = childrenByParentRunId.get(parentRunId);
    siblings?.delete(runId);
    if (siblings?.size === 0) {
      childrenByParentRunId.delete(parentRunId);
    }
    pruneInactiveRunLineage(parentRunId);
  };

  const abortRunIdsAndDescendants = (
    initialRunIds: Iterable<RunId>,
    reason?: unknown,
  ): boolean => {
    const pendingRunIds = [...initialRunIds];
    const visitedRunIds = new Set<RunId>();
    let foundActiveRun = false;

    while (pendingRunIds.length > 0) {
      const runId = pendingRunIds.pop();
      if (runId === undefined || visitedRunIds.has(runId)) {
        continue;
      }
      visitedRunIds.add(runId);

      const run = byRunId.get(runId);
      if (run) {
        foundActiveRun = true;
        run.abortController.abort(reason);
      }

      const children = childrenByParentRunId.get(runId);
      if (children) {
        pendingRunIds.push(...children);
      }
    }

    return foundActiveRun;
  };

  return {
    tryStartRun(threadId, run) {
      const validThreadId = assertValidThreadId(threadId);
      assertValidRunId(run.runId);
      assertValidThreadId(run.threadId);
      assertValidThreadId(run.ownerThreadId);
      if (run.parentRunId !== undefined) {
        assertValidRunId(run.parentRunId);
      }
      const existing = byThread.get(validThreadId);
      if (existing) {
        return { ok: false, activeRunId: existing.runId };
      }
      byThread.set(validThreadId, run);
      byRunId.set(run.runId, run);
      let ownerRuns = runIdsByOwnerThread.get(run.ownerThreadId);
      if (!ownerRuns) {
        ownerRuns = new Set<RunId>();
        runIdsByOwnerThread.set(run.ownerThreadId, ownerRuns);
      }
      ownerRuns.add(run.runId);
      ownerThreadIdByRunId.set(run.runId, run.ownerThreadId);
      if (run.parentRunId !== undefined) {
        parentRunIdByRunId.set(run.runId, run.parentRunId);
        let children = childrenByParentRunId.get(run.parentRunId);
        if (!children) {
          children = new Set<RunId>();
          childrenByParentRunId.set(run.parentRunId, children);
        }
        children.add(run.runId);
      }
      return { ok: true };
    },
    finishRun(threadId, runId) {
      const validThreadId = assertValidThreadId(threadId);
      const run = byRunId.get(runId);
      if (!run) {
        return;
      }
      if (run.threadId !== validThreadId) {
        return;
      }
      byThread.delete(run.threadId);
      byRunId.delete(runId);
      pruneInactiveRunLineage(runId);
    },
    getRunById(runId) {
      const run = byRunId.get(runId);
      return run ? snapshotActiveRun(run) : undefined;
    },
    getRunByThreadId(threadId) {
      const run = byThread.get(assertValidThreadId(threadId));
      return run ? snapshotActiveRun(run) : undefined;
    },
    appendPendingInterject(runId, request) {
      const run = byRunId.get(runId);
      if (
        !run ||
        run.abortController.signal.aborted ||
        !run.interject.accepting
      ) {
        return { ok: false, code: 'not_found' };
      }
      const { receivedSeq, bufferDepth } = pushPendingInterject(
        run.interject,
        request.text,
      );
      return { ok: true, receivedSeq, bufferDepth };
    },
    cancelPendingInterject(runId, receivedSeq) {
      const run = byRunId.get(runId);
      if (!run || run.abortController.signal.aborted) {
        return { ok: false, code: 'not_found' };
      }
      return {
        ok: true,
        cancelled: removePendingInterjectBySeq(run.interject, receivedSeq),
      };
    },
    requestPendingInterjectFlush(runId) {
      const run = byRunId.get(runId);
      if (!run || run.abortController.signal.aborted) {
        return { ok: false, code: 'not_found' };
      }
      return { ok: true, flushed: requestInterjectFlush(run.interject) };
    },
    abortRun(runId) {
      const run = byRunId.get(runId);
      if (!run) {
        return false;
      }
      if (run.parentRunId !== undefined) {
        return false;
      }
      run.abortController.abort();
      return true;
    },
    abortRunSubtree(runId, reason) {
      return abortRunIdsAndDescendants([runId], reason);
    },
    abortThreadTree(ownerThreadId) {
      const validOwnerThreadId = assertValidThreadId(ownerThreadId);
      const runIds = runIdsByOwnerThread.get(validOwnerThreadId);
      if (!runIds || runIds.size === 0) {
        return false;
      }
      return abortRunIdsAndDescendants(runIds);
    },
  };
}
