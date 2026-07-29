import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadId } from '@geulbat/protocol/ids';
import type { RunModelId } from '@geulbat/protocol/run-contract';
import type { ThreadStateSettlePayload } from '@geulbat/protocol/run-events';
import type {
  ThreadDetailResponse,
  ThreadMessage,
  ThreadRunPreferences,
  ThreadSubagentTerminalOutcome,
  ThreadSummary,
} from '@geulbat/protocol/threads';

import {
  branchThread,
  deleteThread,
  exportThreadArchive,
  getThread,
  getThreadMessagePage,
  getThreadOpen,
  getThreads,
  importThreadArchive,
  ThreadDeleteConflictError,
} from '../lib/api/threads.js';
import { saveBlobToLocalFile } from '../lib/save-local-file.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { reportVisibleAppError } from './error-reporting.js';
import {
  useThreadSessionSelection,
  type ThreadStateApplyResult,
} from './use-thread-session-selection.js';
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
  newSessionGeneration: number;
  activeModelId: RunModelId | null;
  runPreferences: ThreadRunPreferences | null;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  subagentTerminalOutcomes: ThreadSubagentTerminalOutcome[];
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  deletingThreadId: string | null;
  pendingDeleteThread: ThreadSummary | null;
  exportingThreadId: string | null;
  importingThreadArchive: boolean;
  threadTransferNotice: string | null;
  loadThreads: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  requestDeleteThread: (threadId: string) => void;
  cancelDeleteThread: () => void;
  confirmDeleteThread: () => Promise<void>;
  exportThread: (threadId: string) => Promise<void>;
  importThread: (archive: Blob) => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  trimMessagesForRegenerate: () => void;
  upsertThreadArtifactVersion: (artifact: ThreadArtifactVersion) => void;
  applyThreadSnapshotForRunSettle: (
    thread: ThreadStateSettlePayload,
  ) => ThreadStateApplyResult;
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
  const [exportingThreadId, setExportingThreadId] = useState<string | null>(
    null,
  );
  const [importingThreadArchive, setImportingThreadArchive] = useState(false);
  const [threadTransferNotice, setThreadTransferNotice] = useState<
    string | null
  >(null);
  const threadTransferInFlightRef = useRef(false);
  const openThreadRequestSequenceRef = useRef(0);
  const olderMessagesRequestRef = useRef<{
    threadId: string;
    beforeEntryId: string;
  } | null>(null);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const {
    selectedThreadId,
    setSelectedThreadId: setSelectedThreadIdSelection,
    newSessionGeneration,
    activeModelId,
    runPreferences,
    messages,
    artifacts,
    subagentTerminalOutcomes,
    olderMessagesBeforeEntryId,
    selectThreadSnapshot,
    prependThreadMessagePage,
    applyThreadSnapshotForRunSettle: applyThreadSnapshotSelection,
    appendOptimisticUserMessage,
    trimMessagesForRegenerate,
    upsertThreadArtifactVersion,
    clearThreadSelectionState: clearThreadSelectionStateSelection,
    startNewSession: startNewSessionSelection,
  } = useThreadSessionSelection();

  const invalidateOlderMessagesRequest = useCallback(() => {
    olderMessagesRequestRef.current = null;
    setOlderMessagesLoading(false);
  }, []);

  const setSelectedThreadId = useCallback(
    (threadId: string | null) => {
      openThreadRequestSequenceRef.current += 1;
      invalidateOlderMessagesRequest();
      setSelectedThreadIdSelection(threadId);
    },
    [invalidateOlderMessagesRequest, setSelectedThreadIdSelection],
  );

  const startNewSession = useCallback(() => {
    openThreadRequestSequenceRef.current += 1;
    invalidateOlderMessagesRequest();
    startNewSessionSelection();
  }, [invalidateOlderMessagesRequest, startNewSessionSelection]);

  const clearThreadSelectionState = useCallback(
    (threadId: string) => {
      if (selectedThreadId === threadId) {
        openThreadRequestSequenceRef.current += 1;
        invalidateOlderMessagesRequest();
      }
      clearThreadSelectionStateSelection(threadId);
    },
    [
      clearThreadSelectionStateSelection,
      invalidateOlderMessagesRequest,
      selectedThreadId,
    ],
  );
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
      const requestSequence = openThreadRequestSequenceRef.current + 1;
      openThreadRequestSequenceRef.current = requestSequence;
      invalidateOlderMessagesRequest();
      try {
        const res = await getThreadOpen(threadId);
        if (openThreadRequestSequenceRef.current !== requestSequence) {
          return;
        }
        startTransition(() => {
          selectThreadSnapshot({
            threadId: res.threadId,
            snapshotVersion: res.snapshotVersion,
            ...(res.activeModelId === undefined
              ? {}
              : { activeModelId: res.activeModelId }),
            ...(res.runPreferences === undefined
              ? {}
              : { runPreferences: res.runPreferences }),
            messages: res.messagePage.messages,
            artifacts: res.artifacts ?? [],
            subagentTerminalOutcomes: res.subagentTerminalOutcomes ?? [],
            olderMessagesBeforeEntryId: res.messagePage.olderBeforeEntryId,
          });
          setThreadError(null);
        });
      } catch (err: unknown) {
        if (openThreadRequestSequenceRef.current !== requestSequence) {
          return;
        }
        setThreadError(
          reportThreadSessionError({
            logContext: 'openThread failed',
            visiblePrefix: `Unable to open thread ${threadId}.`,
            error: err,
          }),
        );
      }
    },
    [invalidateOlderMessagesRequest, selectThreadSnapshot],
  );

  const loadOlderMessages = useCallback(async () => {
    const threadId = selectedThreadId;
    const beforeEntryId = olderMessagesBeforeEntryId;
    if (
      threadId === null ||
      beforeEntryId === null ||
      olderMessagesRequestRef.current !== null
    ) {
      return;
    }
    const request = { threadId, beforeEntryId };
    olderMessagesRequestRef.current = request;
    setOlderMessagesLoading(true);
    try {
      const page = await getThreadMessagePage(threadId, beforeEntryId);
      if (olderMessagesRequestRef.current !== request) {
        return;
      }
      startTransition(() => {
        prependThreadMessagePage({ threadId, beforeEntryId, page });
        setThreadError(null);
      });
    } catch (err: unknown) {
      if (olderMessagesRequestRef.current !== request) {
        return;
      }
      setThreadError(
        reportThreadSessionError({
          logContext: 'loadOlderMessages failed',
          visiblePrefix: `Unable to load older messages for thread ${threadId}.`,
          error: err,
        }),
      );
    } finally {
      if (olderMessagesRequestRef.current === request) {
        olderMessagesRequestRef.current = null;
        setOlderMessagesLoading(false);
      }
    }
  }, [olderMessagesBeforeEntryId, prependThreadMessagePage, selectedThreadId]);

  const exportThread = useCallback(async (threadId: string) => {
    if (threadTransferInFlightRef.current) {
      return;
    }
    threadTransferInFlightRef.current = true;
    setExportingThreadId(threadId);
    setThreadTransferNotice(null);
    try {
      const archive = await exportThreadArchive(threadId);
      const saved = await saveBlobToLocalFile({
        suggestedName: `geulbat-thread-${threadId}.json`,
        blob: archive,
      });
      if (saved) {
        setThreadTransferNotice('대화 아카이브를 내보냈습니다.');
        setThreadError(null);
      }
    } catch (error: unknown) {
      setThreadError(
        reportThreadSessionError({
          logContext: 'exportThread failed',
          visiblePrefix: `대화 ${threadId}을(를) 내보내지 못했습니다.`,
          error,
        }),
      );
    } finally {
      threadTransferInFlightRef.current = false;
      setExportingThreadId(null);
    }
  }, []);

  const importThread = useCallback(
    async (archive: Blob) => {
      if (threadTransferInFlightRef.current) {
        return;
      }
      threadTransferInFlightRef.current = true;
      setImportingThreadArchive(true);
      setThreadTransferNotice(null);
      try {
        const imported = await importThreadArchive(archive);
        setThreadTransferNotice(
          `대화를 가져왔습니다 · 메시지 ${imported.importedMessageCount}개`,
        );
        setThreadError(null);
        await loadThreads();
        await openThread(imported.threadId);
      } catch (error: unknown) {
        setThreadError(
          reportThreadSessionError({
            logContext: 'importThread failed',
            visiblePrefix: '대화를 가져오지 못했습니다.',
            error,
          }),
        );
      } finally {
        threadTransferInFlightRef.current = false;
        setImportingThreadArchive(false);
      }
    },
    [loadThreads, openThread],
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
    newSessionGeneration,
    activeModelId,
    runPreferences,
    messages,
    artifacts,
    subagentTerminalOutcomes,
    hasOlderMessages: olderMessagesBeforeEntryId !== null,
    olderMessagesLoading,
    deletingThreadId,
    pendingDeleteThread,
    exportingThreadId,
    importingThreadArchive,
    threadTransferNotice,
    loadThreads,
    openThread,
    loadOlderMessages,
    openThreadForRunSettle,
    requestDeleteThread,
    cancelDeleteThread,
    confirmDeleteThread,
    exportThread,
    importThread,
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
