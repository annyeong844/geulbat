import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage, ThreadSummary } from '@geulbat/protocol/threads';

interface ProjectWorkspaceThreadsInput {
  threads: ThreadSummary[];
  threadError: string | null;
  selectedThreadId: string | null;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  deletingThreadId: string | null;
  pendingDeleteThread: ThreadSummary | null;
  loadThreads: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  requestDeleteThread: (threadId: string) => void;
  cancelDeleteThread: () => void;
  confirmDeleteThread: () => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  appendOptimisticUserMessage: (prompt: string) => void;
}

type ProjectWorkspaceThreadsSource = ProjectWorkspaceThreadsInput;

export function createProjectWorkspaceThreadsInput(
  threads: ProjectWorkspaceThreadsSource,
): ProjectWorkspaceThreadsInput {
  return {
    threads: threads.threads,
    threadError: threads.threadError,
    selectedThreadId: threads.selectedThreadId,
    messages: threads.messages,
    artifacts: threads.artifacts,
    deletingThreadId: threads.deletingThreadId,
    pendingDeleteThread: threads.pendingDeleteThread,
    loadThreads: threads.loadThreads,
    openThread: threads.openThread,
    requestDeleteThread: threads.requestDeleteThread,
    cancelDeleteThread: threads.cancelDeleteThread,
    confirmDeleteThread: threads.confirmDeleteThread,
    setSelectedThreadId: threads.setSelectedThreadId,
    appendOptimisticUserMessage: threads.appendOptimisticUserMessage,
  };
}
