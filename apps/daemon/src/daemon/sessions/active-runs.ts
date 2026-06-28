import {
  type RunId,
  type ThreadId,
  assertSessionRunId as assertValidRunId,
  assertSessionThreadId as assertValidThreadId,
} from './contract.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';
import {
  pushPendingInterject,
  type RunInterjectBuffer,
} from './active-run-interject-buffer.js';

export interface ActiveRun extends RunWorkspaceContext {
  runId: RunId;
  ownerThreadId: ThreadId;
  abortController: AbortController;
  interject: RunInterjectBuffer;
  startedAt: string;
  parentRunId?: RunId;
}

interface ActiveRunSnapshot extends RunWorkspaceContext {
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
  getRunById(runId: RunId):
    | (RunWorkspaceContext & {
        runId: RunId;
        ownerThreadId: ThreadId;
        startedAt: string;
        parentRunId?: RunId;
        aborted: boolean;
      })
    | undefined;
  getRunByThreadId(threadId: string):
    | (RunWorkspaceContext & {
        runId: RunId;
        ownerThreadId: ThreadId;
        startedAt: string;
        parentRunId?: RunId;
        aborted: boolean;
      })
    | undefined;
  getRunByProjectId(projectId: string):
    | (RunWorkspaceContext & {
        runId: RunId;
        ownerThreadId: ThreadId;
        startedAt: string;
        parentRunId?: RunId;
        aborted: boolean;
      })
    | undefined;
  appendPendingInterject(
    runId: RunId,
    request: { text: string },
  ):
    | { ok: true; receivedSeq: number; bufferDepth: number }
    | { ok: false; code: 'not_found' };
  abortRun(runId: RunId): boolean;
  abortTrackedRun(runId: RunId, reason?: unknown): boolean;
  abortThreadTree(ownerThreadId: string): boolean;
}

function snapshotActiveRun(run: ActiveRun): ActiveRunSnapshot {
  return {
    runId: run.runId,
    threadId: run.threadId,
    projectId: run.projectId,
    workspaceRoot: run.workspaceRoot,
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
      const ownerRuns = runIdsByOwnerThread.get(run.ownerThreadId);
      if (!ownerRuns) {
        return;
      }
      ownerRuns.delete(run.runId);
      if (ownerRuns.size === 0) {
        runIdsByOwnerThread.delete(run.ownerThreadId);
      }
    },
    getRunById(runId) {
      const run = byRunId.get(runId);
      return run ? snapshotActiveRun(run) : undefined;
    },
    getRunByThreadId(threadId) {
      const run = byThread.get(assertValidThreadId(threadId));
      return run ? snapshotActiveRun(run) : undefined;
    },
    getRunByProjectId(projectId) {
      for (const run of byRunId.values()) {
        if (run.projectId === projectId) {
          return snapshotActiveRun(run);
        }
      }
      return undefined;
    },
    appendPendingInterject(runId, request) {
      const run = byRunId.get(runId);
      if (!run || run.abortController.signal.aborted) {
        return { ok: false, code: 'not_found' };
      }
      const { receivedSeq, bufferDepth } = pushPendingInterject(
        run.interject,
        request.text,
      );
      return { ok: true, receivedSeq, bufferDepth };
    },
    abortRun(runId) {
      const run = byRunId.get(runId);
      if (!run) return false;
      if (run.parentRunId !== undefined) return false;
      run.abortController.abort();
      return true;
    },
    abortTrackedRun(runId, reason) {
      const run = byRunId.get(runId);
      if (!run) return false;
      run.abortController.abort(reason);
      return true;
    },
    abortThreadTree(ownerThreadId) {
      const validOwnerThreadId = assertValidThreadId(ownerThreadId);
      const runIds = runIdsByOwnerThread.get(validOwnerThreadId);
      if (!runIds || runIds.size === 0) {
        return false;
      }
      for (const runId of runIds) {
        const run = byRunId.get(runId);
        if (!run) {
          continue;
        }
        run.abortController.abort();
      }
      return true;
    },
  };
}
