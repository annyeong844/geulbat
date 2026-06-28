import { useCallback, useRef, useState } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

interface ThreadSnapshotSelectionState {
  threadId: string;
  snapshotVersion: string;
  messages: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
}

interface UseThreadSessionSelectionResult {
  selectedThreadId: string | null;
  setSelectedThreadId: (threadId: string | null) => void;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  selectThreadSnapshot: (thread: ThreadSnapshotSelectionState) => void;
  applyThreadSnapshotForRunSettle: (
    thread: ThreadSnapshotSelectionState,
  ) => boolean;
  appendOptimisticUserMessage: (prompt: string) => void;
  clearThreadSelectionState: (threadId: string) => void;
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
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [artifacts, setArtifacts] = useState<ThreadArtifactVersion[]>([]);
  const latestSnapshotVersionByThreadRef = useRef<Record<string, string>>({});
  const optimisticMessageIndexRef = useRef(0);

  const selectThreadSnapshot = useCallback(
    (thread: ThreadSnapshotSelectionState) => {
      latestSnapshotVersionByThreadRef.current[thread.threadId] =
        thread.snapshotVersion;
      setSelectedThreadId(thread.threadId);
      setMessages(thread.messages);
      setArtifacts(thread.artifacts ?? []);
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

  const appendOptimisticUserMessage = useCallback((prompt: string) => {
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
      },
    ]);
  }, []);

  const clearThreadSelectionState = useCallback(
    (threadId: string) => {
      if (selectedThreadId === threadId) {
        setSelectedThreadId(null);
        setMessages([]);
        setArtifacts([]);
      }
      delete latestSnapshotVersionByThreadRef.current[threadId];
    },
    [selectedThreadId],
  );

  return {
    selectedThreadId,
    setSelectedThreadId,
    messages,
    artifacts,
    selectThreadSnapshot,
    applyThreadSnapshotForRunSettle,
    appendOptimisticUserMessage,
    clearThreadSelectionState,
  };
}
