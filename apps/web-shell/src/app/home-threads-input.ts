import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type {
  ThreadMessage,
  ThreadSubagentTerminalOutcome,
  ThreadSummary,
} from '@geulbat/protocol/threads';

import type { BranchBeforeEntryResult } from './use-thread-sessions.js';

interface HomeThreadsInput {
  threads: ThreadSummary[];
  threadError: string | null;
  selectedThreadId: string | null;
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  subagentTerminalOutcomes: ThreadSubagentTerminalOutcome[];
  messageHistory: {
    hasOlderMessages: boolean;
    isLoading: boolean;
    onLoadOlder: () => Promise<void>;
  };
  deletingThreadId: string | null;
  pendingDeleteThread: ThreadSummary | null;
  exportingThreadId: string | null;
  importingThreadArchive: boolean;
  threadTransferNotice: string | null;
  loadThreads: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
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
  startNewSession: () => void;
  branchThreadFromEntry: (entryId: string) => Promise<void>;
  branchThreadBeforeEntry: (
    entryId: string,
  ) => Promise<BranchBeforeEntryResult>;
  branchNotice: string | null;
  dismissBranchNotice: () => void;
}

interface HomeThreadsSource extends Omit<HomeThreadsInput, 'messageHistory'> {
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  loadOlderMessages: () => Promise<void>;
}

export function createHomeThreadsInput(
  threads: HomeThreadsSource,
): HomeThreadsInput {
  return {
    threads: threads.threads,
    threadError: threads.threadError,
    selectedThreadId: threads.selectedThreadId,
    messages: threads.messages,
    artifacts: threads.artifacts,
    subagentTerminalOutcomes: threads.subagentTerminalOutcomes,
    messageHistory: {
      hasOlderMessages: threads.hasOlderMessages,
      isLoading: threads.olderMessagesLoading,
      onLoadOlder: threads.loadOlderMessages,
    },
    deletingThreadId: threads.deletingThreadId,
    pendingDeleteThread: threads.pendingDeleteThread,
    exportingThreadId: threads.exportingThreadId,
    importingThreadArchive: threads.importingThreadArchive,
    threadTransferNotice: threads.threadTransferNotice,
    loadThreads: threads.loadThreads,
    openThread: threads.openThread,
    requestDeleteThread: threads.requestDeleteThread,
    cancelDeleteThread: threads.cancelDeleteThread,
    confirmDeleteThread: threads.confirmDeleteThread,
    exportThread: threads.exportThread,
    importThread: threads.importThread,
    setSelectedThreadId: threads.setSelectedThreadId,
    appendOptimisticUserMessage: threads.appendOptimisticUserMessage,
    startNewSession: threads.startNewSession,
    branchThreadFromEntry: threads.branchThreadFromEntry,
    branchThreadBeforeEntry: threads.branchThreadBeforeEntry,
    branchNotice: threads.branchNotice,
    dismissBranchNotice: threads.dismissBranchNotice,
  };
}
