import type {
  RunRequest,
  RunStartRequest,
} from '@geulbat/protocol/run-contract';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';
import type { prepareThreadProviderTransition } from '../lib/api/threads.js';

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
  workingDirectory?: string;
  selectedFile: string | null;
  selectedThreadId: string | null;
  loadThreads: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  trimMessagesForRegenerate: () => void;
  loadTree: () => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  applyThreadSnapshotForRunSettle?: (thread: ThreadDetailResponse) => boolean;
  createClient?: () => RunSessionControllerClient;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
  prepareProviderTransitionRequest?: typeof prepareThreadProviderTransition;
}

export function useRunSession({
  workingDirectory,
  selectedFile,
  selectedThreadId,
  loadThreads,
  loadTree,
  openFile,
  appendOptimisticUserMessage,
  trimMessagesForRegenerate,
  setSelectedThreadId,
  openThreadForRunSettle,
  applyThreadSnapshotForRunSettle = () => true,
  createClient,
  prepareStartRequest,
  prepareProviderTransitionRequest,
}: UseRunSessionArgs): RunSessionViewModel {
  const {
    state,
    permissionMode,
    setPermissionMode,
    modelId,
    setModelId,
    prepareProviderTransition,
    reasoningEffort,
    setReasoningEffort,
    subagentModelRouting,
    setSubagentModelRouting,
    sendPrompt,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  } = useRunSessionRuntime({
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    selectedFile,
    selectedThreadId,
    loadThreads,
    loadTree,
    openFile,
    appendOptimisticUserMessage,
    trimMessagesForRegenerate,
    setSelectedThreadId,
    openThreadForRunSettle,
    applyThreadSnapshotForRunSettle,
    ...(createClient ? { createClient } : {}),
    ...(prepareStartRequest ? { prepareStartRequest } : {}),
    ...(prepareProviderTransitionRequest
      ? { prepareProviderTransitionRequest }
      : {}),
  });

  return createRunSessionViewModel({
    selectedThreadId,
    state,
    permissionMode,
    setPermissionMode,
    modelId,
    setModelId,
    prepareProviderTransition,
    reasoningEffort,
    setReasoningEffort,
    subagentModelRouting,
    setSubagentModelRouting,
    sendPrompt,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  });
}
