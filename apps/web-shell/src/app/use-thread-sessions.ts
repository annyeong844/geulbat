import { useCallback, useState } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type {
  ThreadDetailResponse,
  ThreadMessage,
  ThreadSummary,
} from '@geulbat/protocol/threads';

import {
  deleteThread,
  getThread,
  getThreads,
  ThreadDeleteConflictError,
} from '../lib/api/threads.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { brandProjectId } from '../lib/id-brand-helpers.js';
import { reportVisibleAppError } from './error-reporting.js';
import { useThreadSessionSelection } from './use-thread-session-selection.js';
const logger = createLogger('thread-sessions');

interface ReportThreadSessionErrorArgs {
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}

interface UseThreadSessionsResult {
  threads: ThreadSummary[];
  threadError: string | null;
  selectedThreadId: string | null;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  deletingThreadId: string | null;
  pendingDeleteThread: ThreadSummary | null;
  loadThreads: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  requestDeleteThread: (threadId: string) => void;
  cancelDeleteThread: () => void;
  confirmDeleteThread: () => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  appendOptimisticUserMessage: (prompt: string) => void;
  applyThreadSnapshotForRunSettle: (thread: ThreadDetailResponse) => boolean;
}

function reportThreadSessionError({
  logContext,
  visiblePrefix,
  error,
}: ReportThreadSessionErrorArgs): string {
  return reportVisibleAppError({
    logger,
    logContext,
    visiblePrefix,
    error,
  });
}

function buildThreadDeleteConflictMessage(
  error: ThreadDeleteConflictError,
): string {
  const body = error.conflict;
  return `Unable to delete thread ${body.threadId}. Active run ${body.activeRunId} is still in progress.`;
}

export function useThreadSessions(projectId: string): UseThreadSessionsResult {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<
    string | null
  >(null);
  const {
    selectedThreadId,
    setSelectedThreadId,
    messages,
    artifacts,
    selectThreadSnapshot,
    applyThreadSnapshotForRunSettle: applyThreadSnapshotSelection,
    appendOptimisticUserMessage,
    clearThreadSelectionState,
  } = useThreadSessionSelection();

  const applyThreadSnapshotForRunSettle = useCallback(
    (thread: Parameters<typeof applyThreadSnapshotSelection>[0]) => {
      const applied = applyThreadSnapshotSelection(thread);
      if (applied) {
        setThreadError(null);
      }
      return applied;
    },
    [applyThreadSnapshotSelection],
  );

  const loadThreads = useCallback(async () => {
    try {
      const res = await getThreads(brandProjectId(projectId));
      setThreads(res.threads);
      setThreadError(null);
    } catch (err: unknown) {
      setThreadError(
        reportThreadSessionError({
          logContext: 'loadThreads failed',
          visiblePrefix: 'Unable to load threads.',
          error: err,
        }),
      );
    }
  }, [projectId]);

  const loadThreadDetail = useCallback(
    async (threadId: string) => {
      try {
        return await getThread(threadId, brandProjectId(projectId));
      } catch (err: unknown) {
        setThreadError(
          reportThreadSessionError({
            logContext: 'openThread failed',
            visiblePrefix: `Unable to open thread ${threadId}.`,
            error: err,
          }),
        );
        return null;
      }
    },
    [projectId],
  );

  const openThreadForRunSettle = useCallback(
    async (threadId: string) => {
      const res = await loadThreadDetail(threadId);
      if (!res) {
        return null;
      }
      return applyThreadSnapshotForRunSettle(res) ? res : null;
    },
    [applyThreadSnapshotForRunSettle, loadThreadDetail],
  );

  const openThread = useCallback(
    async (threadId: string) => {
      const res = await loadThreadDetail(threadId);
      if (res) {
        selectThreadSnapshot(res);
        setThreadError(null);
      }
    },
    [loadThreadDetail, selectThreadSnapshot],
  );

  const deleteSelectedThreadState = useCallback(
    (threadId: string) => {
      setThreads((prev) =>
        prev.filter((thread) => thread.threadId !== threadId),
      );
      setThreadError(null);
      clearThreadSelectionState(threadId);
    },
    [clearThreadSelectionState],
  );

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      setDeletingThreadId(threadId);
      try {
        await deleteThread(threadId, brandProjectId(projectId));
        deleteSelectedThreadState(threadId);
      } catch (err: unknown) {
        if (err instanceof ThreadDeleteConflictError) {
          setThreadError(buildThreadDeleteConflictMessage(err));
          return;
        }
        setThreadError(
          reportThreadSessionError({
            logContext: 'deleteThread failed',
            visiblePrefix: `Unable to delete thread ${threadId}.`,
            error: err,
          }),
        );
      } finally {
        setDeletingThreadId((current) =>
          current === threadId ? null : current,
        );
      }
    },
    [deleteSelectedThreadState, projectId],
  );

  const requestDeleteThread = useCallback((threadId: string) => {
    setPendingDeleteThreadId(threadId);
    setThreadError(null);
  }, []);

  const cancelDeleteThread = useCallback(() => {
    setPendingDeleteThreadId(null);
  }, []);

  const confirmDeleteThread = useCallback(async () => {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    try {
      await handleDeleteThread(threadId);
    } finally {
      setPendingDeleteThreadId((current) =>
        current === threadId ? null : current,
      );
    }
  }, [handleDeleteThread, pendingDeleteThreadId]);

  const pendingDeleteThread =
    pendingDeleteThreadId === null
      ? null
      : (threads.find((thread) => thread.threadId === pendingDeleteThreadId) ??
        null);

  return {
    threads,
    threadError,
    selectedThreadId,
    messages,
    artifacts,
    deletingThreadId,
    pendingDeleteThread,
    loadThreads,
    openThread,
    openThreadForRunSettle,
    requestDeleteThread,
    cancelDeleteThread,
    confirmDeleteThread,
    setSelectedThreadId,
    appendOptimisticUserMessage,
    applyThreadSnapshotForRunSettle,
  };
}
