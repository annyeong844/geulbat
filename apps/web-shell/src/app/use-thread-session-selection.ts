import { useCallback, useRef, useState } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunModelId } from '@geulbat/protocol/run-contract';
import {
  isThreadStatePersistedDelta,
  type ThreadStateSettlePayload,
} from '@geulbat/protocol/run-events';
import type {
  ThreadMessage,
  ThreadMessagePageResponse,
  ThreadRunPreferences,
  ThreadSubagentTerminalOutcome,
} from '@geulbat/protocol/threads';
import { isSilentUserMessage } from '../lib/silent-user-message.js';

interface ThreadSnapshotSelectionState {
  threadId: string;
  snapshotVersion: string;
  activeModelId?: RunModelId;
  runPreferences?: ThreadRunPreferences;
  messages: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  subagentTerminalOutcomes?: ThreadSubagentTerminalOutcome[];
  olderMessagesBeforeEntryId?: string | null;
}

interface ThreadSelectionState {
  selectedThreadId: string | null;
  activeModelId: RunModelId | null;
  runPreferences: ThreadRunPreferences | null;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  subagentTerminalOutcomes: ThreadSubagentTerminalOutcome[];
  olderMessagesBeforeEntryId: string | null;
}

interface UseThreadSessionSelectionResult {
  selectedThreadId: string | null;
  setSelectedThreadId: (threadId: string | null) => void;
  newSessionGeneration: number;
  activeModelId: RunModelId | null;
  runPreferences: ThreadRunPreferences | null;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  subagentTerminalOutcomes: ThreadSubagentTerminalOutcome[];
  olderMessagesBeforeEntryId: string | null;
  selectThreadSnapshot: (thread: ThreadSnapshotSelectionState) => void;
  prependThreadMessagePage: (args: {
    threadId: string;
    beforeEntryId: string;
    page: ThreadMessagePageResponse;
  }) => void;
  applyThreadSnapshotForRunSettle: (
    thread: ThreadStateSettlePayload,
  ) => ThreadStateApplyResult;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  trimMessagesForRegenerate: () => void;
  // draft → 버전 커밋 직후 서버 재조회 없이 로컬 아티팩트 목록에 반영한다
  upsertThreadArtifactVersion: (artifact: ThreadArtifactVersion) => void;
  clearThreadSelectionState: (threadId: string) => void;
  startNewSession: () => void;
}

export type ThreadStateApplyResult = boolean | 'missing_base';

function isSnapshotVersionNewer(
  nextVersion: string,
  currentVersion: string | undefined,
): boolean {
  if (currentVersion === undefined) {
    return true;
  }
  return nextVersion.localeCompare(currentVersion) > 0;
}

function createOptimisticThreadMessageId(index: number): string {
  return `optimistic:${Date.now().toString(36)}:${index.toString(36)}`;
}

function createEmptyThreadSelectionState(): ThreadSelectionState {
  return {
    selectedThreadId: null,
    activeModelId: null,
    runPreferences: null,
    messages: [],
    artifacts: [],
    subagentTerminalOutcomes: [],
    olderMessagesBeforeEntryId: null,
  };
}

export function useThreadSessionSelection(): UseThreadSessionSelectionResult {
  const [newSessionGeneration, setNewSessionGeneration] = useState(0);
  const [selection, setSelection] = useState<ThreadSelectionState>(
    createEmptyThreadSelectionState,
  );
  const latestSnapshotVersionByThreadRef = useRef<Record<string, string>>({});
  const optimisticMessageIndexRef = useRef(0);
  const {
    selectedThreadId,
    activeModelId,
    runPreferences,
    messages,
    artifacts,
    subagentTerminalOutcomes,
    olderMessagesBeforeEntryId,
  } = selection;

  const setSelectedThreadId = useCallback((threadId: string | null) => {
    setSelection((current) =>
      current.selectedThreadId === threadId
        ? current
        : { ...current, selectedThreadId: threadId },
    );
  }, []);

  const selectThreadSnapshot = useCallback(
    (thread: ThreadSnapshotSelectionState) => {
      latestSnapshotVersionByThreadRef.current[thread.threadId] =
        thread.snapshotVersion;
      setSelection({
        selectedThreadId: thread.threadId,
        activeModelId: thread.activeModelId ?? null,
        runPreferences: thread.runPreferences ?? null,
        messages: thread.messages,
        artifacts: thread.artifacts ?? [],
        subagentTerminalOutcomes: thread.subagentTerminalOutcomes ?? [],
        olderMessagesBeforeEntryId: thread.olderMessagesBeforeEntryId ?? null,
      });
    },
    [],
  );

  const prependThreadMessagePage = useCallback(
    ({
      threadId,
      beforeEntryId,
      page,
    }: {
      threadId: string;
      beforeEntryId: string;
      page: ThreadMessagePageResponse;
    }) => {
      setSelection((current) => {
        if (
          page.threadId !== threadId ||
          current.selectedThreadId !== threadId ||
          current.messages[0]?.entryId !== beforeEntryId
        ) {
          return current;
        }
        return {
          ...current,
          messages: [...page.messages, ...current.messages],
          olderMessagesBeforeEntryId: page.olderBeforeEntryId,
        };
      });
    },
    [],
  );

  const applyThreadSnapshotForRunSettle = useCallback(
    (thread: ThreadStateSettlePayload): ThreadStateApplyResult => {
      const latestSnapshotVersion =
        latestSnapshotVersionByThreadRef.current[thread.threadId];
      if (
        !isSnapshotVersionNewer(thread.snapshotVersion, latestSnapshotVersion)
      ) {
        return false;
      }
      if (!isThreadStatePersistedDelta(thread)) {
        selectThreadSnapshot(thread);
        return true;
      }
      const baseMessageIndex =
        thread.baseEntryId === null
          ? -1
          : selectedThreadId === thread.threadId
            ? messages.findIndex(
                (message) => message.entryId === thread.baseEntryId,
              )
            : -1;
      if (thread.baseEntryId !== null && baseMessageIndex < 0) {
        return 'missing_base';
      }

      latestSnapshotVersionByThreadRef.current[thread.threadId] =
        thread.snapshotVersion;
      setSelection({
        selectedThreadId: thread.threadId,
        activeModelId: thread.activeModelId ?? null,
        runPreferences: thread.runPreferences ?? null,
        messages: [
          ...messages.slice(0, baseMessageIndex + 1),
          ...thread.messages,
        ],
        artifacts: thread.artifacts ?? [],
        subagentTerminalOutcomes: [],
        olderMessagesBeforeEntryId:
          thread.baseEntryId === null ? null : olderMessagesBeforeEntryId,
      });
      return true;
    },
    [
      messages,
      olderMessagesBeforeEntryId,
      selectThreadSnapshot,
      selectedThreadId,
    ],
  );

  const appendOptimisticUserMessage = useCallback(
    (prompt: string, origin?: 'artifact_frame') => {
      optimisticMessageIndexRef.current += 1;
      setSelection((current) => ({
        ...current,
        messages: [
          ...current.messages,
          {
            entryId: createOptimisticThreadMessageId(
              optimisticMessageIndexRef.current,
            ),
            role: 'user',
            content: prompt,
            timestamp: new Date().toISOString(),
            // 아티팩트 발 턴은 낙관 단계부터 귀속 배지를 단다 — settle 후
            // 데몬이 같은 값을 metadata.origin으로 확정한다
            ...(origin !== undefined ? { metadata: { origin } } : {}),
          },
        ],
      }));
    },
    [],
  );

  const upsertThreadArtifactVersion = useCallback(
    (artifact: ThreadArtifactVersion) => {
      setSelection((current) => ({
        ...current,
        artifacts: [
          ...current.artifacts.filter(
            (candidate) =>
              !(
                candidate.artifactId === artifact.artifactId &&
                candidate.version === artifact.version
              ),
          ),
          artifact,
        ],
      }));
    },
    [],
  );

  // 답변 재생성의 옵티미스틱 뷰 — 마지막 가시 질문과 그 뒤 전부를 걷어낸다.
  // 이어지는 낙관적 append가 (수정된) 질문을 즉시 그 자리에 다시 그리므로
  // 수정 제출 순간 화면이 바뀌고, 데몬 truncate(같은 기준)와도 일치한다.
  const trimMessagesForRegenerate = useCallback(() => {
    setSelection((current) => {
      let end = current.messages.length;
      // silent user 턴(♻ 등 UI 발 자동 요청)은 화면의 질문이 아니다
      while (end > 0) {
        const message = current.messages[end - 1];
        if (message?.role === 'user' && !isSilentUserMessage(message)) {
          break;
        }
        end -= 1;
      }
      if (end === 0) {
        return current;
      }
      // 질문 자체까지 제거 — 새(수정된) 질문이 낙관적으로 대체한다
      return { ...current, messages: current.messages.slice(0, end - 1) };
    });
  }, []);

  // 새 세션 — thread 선택 해제. 다음 메시지가 새 thread를 연다.
  const startNewSession = useCallback(() => {
    setNewSessionGeneration((current) => current + 1);
    setSelection(createEmptyThreadSelectionState());
  }, []);

  const clearThreadSelectionState = useCallback(
    (threadId: string) => {
      if (selectedThreadId === threadId) {
        setNewSessionGeneration((current) => current + 1);
        setSelection(createEmptyThreadSelectionState());
      }
      delete latestSnapshotVersionByThreadRef.current[threadId];
    },
    [selectedThreadId],
  );

  return {
    selectedThreadId,
    setSelectedThreadId,
    newSessionGeneration,
    activeModelId,
    runPreferences,
    messages,
    artifacts,
    subagentTerminalOutcomes,
    olderMessagesBeforeEntryId,
    selectThreadSnapshot,
    prependThreadMessagePage,
    applyThreadSnapshotForRunSettle,
    appendOptimisticUserMessage,
    trimMessagesForRegenerate,
    upsertThreadArtifactVersion,
    clearThreadSelectionState,
    startNewSession,
  };
}
