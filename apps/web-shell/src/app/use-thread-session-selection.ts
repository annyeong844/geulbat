import { useCallback, useRef, useState } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunModelId } from '@geulbat/protocol/run-contract';
import type {
  ThreadMessage,
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
  selectThreadSnapshot: (thread: ThreadSnapshotSelectionState) => void;
  applyThreadSnapshotForRunSettle: (
    thread: ThreadSnapshotSelectionState,
  ) => boolean;
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

export function useThreadSessionSelection(): UseThreadSessionSelectionResult {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [newSessionGeneration, setNewSessionGeneration] = useState(0);
  const [activeModelId, setActiveModelId] = useState<RunModelId | null>(null);
  const [runPreferences, setRunPreferences] =
    useState<ThreadRunPreferences | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [artifacts, setArtifacts] = useState<ThreadArtifactVersion[]>([]);
  const [subagentTerminalOutcomes, setSubagentTerminalOutcomes] = useState<
    ThreadSubagentTerminalOutcome[]
  >([]);
  const latestSnapshotVersionByThreadRef = useRef<Record<string, string>>({});
  const optimisticMessageIndexRef = useRef(0);

  const selectThreadSnapshot = useCallback(
    (thread: ThreadSnapshotSelectionState) => {
      latestSnapshotVersionByThreadRef.current[thread.threadId] =
        thread.snapshotVersion;
      setSelectedThreadId(thread.threadId);
      setActiveModelId(thread.activeModelId ?? null);
      setRunPreferences(thread.runPreferences ?? null);
      setMessages(thread.messages);
      setArtifacts(thread.artifacts ?? []);
      setSubagentTerminalOutcomes(thread.subagentTerminalOutcomes ?? []);
    },
    [],
  );

  const applyThreadSnapshotForRunSettle = useCallback(
    (thread: ThreadSnapshotSelectionState) => {
      const latestSnapshotVersion =
        latestSnapshotVersionByThreadRef.current[thread.threadId];
      if (
        !isSnapshotVersionNewer(thread.snapshotVersion, latestSnapshotVersion)
      ) {
        return false;
      }
      selectThreadSnapshot(thread);
      return true;
    },
    [selectThreadSnapshot],
  );

  const appendOptimisticUserMessage = useCallback(
    (prompt: string, origin?: 'artifact_frame') => {
      optimisticMessageIndexRef.current += 1;
      setMessages((prev) => [
        ...prev,
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
      ]);
    },
    [],
  );

  const upsertThreadArtifactVersion = useCallback(
    (artifact: ThreadArtifactVersion) => {
      setArtifacts((prev) => [
        ...prev.filter(
          (candidate) =>
            !(
              candidate.artifactId === artifact.artifactId &&
              candidate.version === artifact.version
            ),
        ),
        artifact,
      ]);
    },
    [],
  );

  // 답변 재생성의 옵티미스틱 뷰 — 마지막 가시 질문과 그 뒤 전부를 걷어낸다.
  // 이어지는 낙관적 append가 (수정된) 질문을 즉시 그 자리에 다시 그리므로
  // 수정 제출 순간 화면이 바뀌고, 데몬 truncate(같은 기준)와도 일치한다.
  const trimMessagesForRegenerate = useCallback(() => {
    setMessages((prev) => {
      let end = prev.length;
      // silent user 턴(♻ 등 UI 발 자동 요청)은 화면의 질문이 아니다
      while (end > 0) {
        const message = prev[end - 1];
        if (message?.role === 'user' && !isSilentUserMessage(message)) {
          break;
        }
        end -= 1;
      }
      if (end === 0) {
        return prev;
      }
      // 질문 자체까지 제거 — 새(수정된) 질문이 낙관적으로 대체한다
      return prev.slice(0, end - 1);
    });
  }, []);

  // 새 세션 — thread 선택 해제. 다음 메시지가 새 thread를 연다.
  const startNewSession = useCallback(() => {
    setNewSessionGeneration((current) => current + 1);
    setSelectedThreadId(null);
    setActiveModelId(null);
    setRunPreferences(null);
    setMessages([]);
    setArtifacts([]);
    setSubagentTerminalOutcomes([]);
  }, []);

  const clearThreadSelectionState = useCallback(
    (threadId: string) => {
      if (selectedThreadId === threadId) {
        setNewSessionGeneration((current) => current + 1);
        setSelectedThreadId(null);
        setActiveModelId(null);
        setRunPreferences(null);
        setMessages([]);
        setArtifacts([]);
        setSubagentTerminalOutcomes([]);
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
    selectThreadSnapshot,
    applyThreadSnapshotForRunSettle,
    appendOptimisticUserMessage,
    trimMessagesForRegenerate,
    upsertThreadArtifactVersion,
    clearThreadSelectionState,
    startNewSession,
  };
}
