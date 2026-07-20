import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';
import type {
  ThreadDetailResponse,
  ThreadMessage,
  ThreadSummary,
} from '@geulbat/protocol/threads';

import {
  branchThread,
  deleteThread,
  getThread,
  getThreads,
  ThreadDeleteConflictError,
} from '../lib/api/threads.js';
import { createLogger } from '@geulbat/structured-logger/logger';
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
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  trimMessagesForRegenerate: () => void;
  upsertThreadArtifactVersion: (artifact: ThreadArtifactVersion) => void;
  applyThreadSnapshotForRunSettle: (thread: ThreadDetailResponse) => boolean;
  startNewSession: () => void;
  branchThreadFromEntry: (entryId: string) => Promise<void>;
  branchThreadBeforeEntry: (
    entryId: string,
  ) => Promise<BranchBeforeEntryResult>;
  branchNotice: string | null;
  dismissBranchNotice: () => void;
}

// 과거 질문 편집용 브랜치 결과 — 'fresh'는 첫 질문 편집(복제할 prefix가
// 없어 새 세션으로 시작), null은 브랜치 불가/실패.
export type BranchBeforeEntryResult =
  | { kind: 'branched'; threadId: ThreadId }
  | { kind: 'fresh' }
  | null;

interface UseThreadDeleteFlowArgs {
  threads: ThreadSummary[];
  setThreads: Dispatch<SetStateAction<ThreadSummary[]>>;
  setThreadError: Dispatch<SetStateAction<string | null>>;
  clearThreadSelectionState: (threadId: string) => void;
}

interface ThreadDeleteFlow {
  deletingThreadId: string | null;
  pendingDeleteThread: ThreadSummary | null;
  requestDeleteThread: (threadId: string) => void;
  cancelDeleteThread: () => void;
  confirmDeleteThread: () => Promise<void>;
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

function useThreadDeleteFlow({
  threads,
  setThreads,
  setThreadError,
  clearThreadSelectionState,
}: UseThreadDeleteFlowArgs): ThreadDeleteFlow {
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<
    string | null
  >(null);

  const deleteSelectedThreadState = useCallback(
    (threadId: string) => {
      setThreads((prev) =>
        prev.filter((thread) => thread.threadId !== threadId),
      );
      setThreadError(null);
      clearThreadSelectionState(threadId);
    },
    [clearThreadSelectionState, setThreadError, setThreads],
  );

  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      setDeletingThreadId(threadId);
      try {
        await deleteThread(threadId);
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
    [deleteSelectedThreadState, setThreadError],
  );

  const requestDeleteThread = useCallback(
    (threadId: string) => {
      setPendingDeleteThreadId(threadId);
      setThreadError(null);
    },
    [setThreadError],
  );

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
    deletingThreadId,
    pendingDeleteThread,
    requestDeleteThread,
    cancelDeleteThread,
    confirmDeleteThread,
  };
}

export function useThreadSessions(): UseThreadSessionsResult {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadError, setThreadError] = useState<string | null>(null);
  const {
    selectedThreadId,
    setSelectedThreadId,
    messages,
    artifacts,
    selectThreadSnapshot,
    applyThreadSnapshotForRunSettle: applyThreadSnapshotSelection,
    appendOptimisticUserMessage,
    trimMessagesForRegenerate,
    upsertThreadArtifactVersion,
    clearThreadSelectionState,
    startNewSession,
  } = useThreadSessionSelection();
  const {
    deletingThreadId,
    pendingDeleteThread,
    requestDeleteThread,
    cancelDeleteThread,
    confirmDeleteThread,
  } = useThreadDeleteFlow({
    threads,
    setThreads,
    setThreadError,
    clearThreadSelectionState,
  });

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
      const res = await getThreads();
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
  }, []);

  const loadThreadDetail = useCallback(async (threadId: string) => {
    try {
      return await getThread(threadId);
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
  }, []);

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

  // 여기서 새 채팅 — entryId 포함 prefix를 복제한 새 스레드를 만들고 목록
  // 갱신 후 곧바로 전환한다. 연타로 브랜치가 중복 생성되지 않게 진행 중
  // 재요청은 무시한다. 전환은 화면상 티가 나지 않으므로(같은 내용의 복제
  // 스레드) 성공 알림을 띄운다 — 없으면 사용자가 모르고 연타해 스레드가
  // 증식한다.
  const branchInFlightRef = useRef(false);
  const [branchNotice, setBranchNotice] = useState<string | null>(null);
  const branchNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (branchNoticeTimerRef.current !== null) {
        clearTimeout(branchNoticeTimerRef.current);
      }
    },
    [],
  );
  const dismissBranchNotice = useCallback(() => {
    if (branchNoticeTimerRef.current !== null) {
      clearTimeout(branchNoticeTimerRef.current);
      branchNoticeTimerRef.current = null;
    }
    setBranchNotice(null);
  }, []);
  const showBranchNotice = useCallback((notice: string) => {
    setBranchNotice(notice);
    if (branchNoticeTimerRef.current !== null) {
      clearTimeout(branchNoticeTimerRef.current);
    }
    branchNoticeTimerRef.current = setTimeout(() => {
      branchNoticeTimerRef.current = null;
      setBranchNotice(null);
    }, 8000);
  }, []);

  // 공통 브랜치 실행 — upToEntryId 포함 prefix 복제 → 목록 갱신 → 전환 →
  // 알림. 성공 시 새 threadId, 실패 시 null.
  const branchAndOpen = useCallback(
    async (
      sourceThreadId: string,
      upToEntryId: string,
      notice: string,
    ): Promise<ThreadId | null> => {
      branchInFlightRef.current = true;
      try {
        const branched = await branchThread(sourceThreadId, upToEntryId);
        await loadThreads();
        await openThread(branched.threadId);
        showBranchNotice(notice);
        return branched.threadId;
      } catch (err: unknown) {
        setThreadError(
          reportThreadSessionError({
            logContext: 'branchThread failed',
            visiblePrefix: `Unable to branch thread ${sourceThreadId}.`,
            error: err,
          }),
        );
        return null;
      } finally {
        branchInFlightRef.current = false;
      }
    },
    [loadThreads, openThread, showBranchNotice],
  );

  const branchThreadFromEntry = useCallback(
    async (entryId: string) => {
      const sourceThreadId = selectedThreadId;
      if (!sourceThreadId || branchInFlightRef.current) {
        return;
      }
      await branchAndOpen(
        sourceThreadId,
        entryId,
        '⑂ 새 채팅으로 전환했습니다 — 원래 대화는 목록에 그대로 있어요.',
      );
    },
    [branchAndOpen, selectedThreadId],
  );

  // 과거 질문 편집용 — 해당 entry "직전"까지 복제한 새 스레드로 전환한다.
  // 수정된 질문은 호출측이 새 스레드에서 run으로 보낸다. 첫 메시지 편집은
  // 복제할 prefix가 없으므로 새 세션 시작으로 처리('fresh').
  const branchThreadBeforeEntry = useCallback(
    async (entryId: string): Promise<BranchBeforeEntryResult> => {
      const sourceThreadId = selectedThreadId;
      if (!sourceThreadId || branchInFlightRef.current) {
        return null;
      }
      const index = messages.findIndex(
        (message) => message.entryId === entryId,
      );
      if (index < 0) {
        return null;
      }
      const previousEntryId = messages[index - 1]?.entryId;
      if (previousEntryId === undefined) {
        startNewSession();
        showBranchNotice(
          '✎ 수정한 질문으로 새 채팅을 시작합니다 — 원래 대화는 목록에 그대로 있어요.',
        );
        return { kind: 'fresh' };
      }
      const threadId = await branchAndOpen(
        sourceThreadId,
        previousEntryId,
        '✎ 수정한 질문으로 새 채팅을 시작합니다 — 원래 대화는 목록에 그대로 있어요.',
      );
      return threadId === null ? null : { kind: 'branched', threadId };
    },
    [
      branchAndOpen,
      messages,
      selectedThreadId,
      showBranchNotice,
      startNewSession,
    ],
  );

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
    trimMessagesForRegenerate,
    upsertThreadArtifactVersion,
    applyThreadSnapshotForRunSettle,
    startNewSession,
    branchThreadFromEntry,
    branchThreadBeforeEntry,
    branchNotice,
    dismissBranchNotice,
  };
}
