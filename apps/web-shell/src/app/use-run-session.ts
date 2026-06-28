import type {
  RunRequest,
  RunStartRequest,
} from '@geulbat/protocol/run-contract';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import { settleRunEffects } from './run-session-settle.js';
import {
  useRunSessionRuntime,
  type RunSessionControllerClient,
} from './use-run-session-runtime.js';
import {
  createRunSessionViewModel,
  type RunSessionViewModel,
} from './run-session-view-model.js';

export { settleRunEffects };
export type { RunSessionControllerClient };

interface UseRunSessionArgs {
  projectId: string;
  selectedFile: string | null;
  selectedThreadId: string | null;
  loadThreads: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  appendOptimisticUserMessage: (prompt: string) => void;
  loadTree: () => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  applyThreadSnapshotForRunSettle?: (thread: ThreadDetailResponse) => boolean;
  createClient?: () => RunSessionControllerClient;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
}

export function useRunSession({
  projectId,
  selectedFile,
  selectedThreadId,
  loadThreads,
  loadTree,
  openFile,
  appendOptimisticUserMessage,
  setSelectedThreadId,
  openThreadForRunSettle,
  applyThreadSnapshotForRunSettle = () => true,
  createClient,
  prepareStartRequest,
}: UseRunSessionArgs): RunSessionViewModel {
  const {
    state,
    permissionMode,
    setPermissionMode,
    sendPrompt,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  } = useRunSessionRuntime({
    projectId,
    selectedFile,
    selectedThreadId,
    loadThreads,
    loadTree,
    openFile,
    appendOptimisticUserMessage,
    setSelectedThreadId,
    openThreadForRunSettle,
    applyThreadSnapshotForRunSettle,
    ...(createClient ? { createClient } : {}),
    ...(prepareStartRequest ? { prepareStartRequest } : {}),
  });

  return createRunSessionViewModel({
    selectedThreadId,
    state,
    permissionMode,
    setPermissionMode,
    sendPrompt,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  });
}
