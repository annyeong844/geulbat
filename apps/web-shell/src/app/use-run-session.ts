import type {
  RunRequest,
  RunStartRequest,
} from '@geulbat/protocol/run-contract';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import type { prepareThreadProviderTransition } from '../lib/api/threads.js';
import type {
  fetchPermissionMode,
  savePermissionMode,
} from '../lib/api/permission-mode.js';

import {
  useRunSessionRuntime,
  type RunSessionControllerClient,
} from './use-run-session-runtime.js';
import {
  createRunSessionViewModel,
  type RunSessionViewModel,
} from './run-session-view-model.js';

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
  readPermissionModeState?: typeof fetchPermissionMode;
  writePermissionModeState?: typeof savePermissionMode;
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
  readPermissionModeState,
  writePermissionModeState,
}: UseRunSessionArgs): RunSessionViewModel {
  // 런타임 반환 계약은 CreateRunSessionViewModelArgs에서 파생된다
  // (UseRunSessionRuntimeResult). 그래서 여기서 필드를 다시 나열하지 않고
  // 그대로 얹는다 — 런타임이 제어 표면을 늘리면 손대지 않아도 흘러간다.
  const runtime = useRunSessionRuntime({
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
    ...(readPermissionModeState ? { readPermissionModeState } : {}),
    ...(writePermissionModeState ? { writePermissionModeState } : {}),
  });

  return createRunSessionViewModel({ selectedThreadId, ...runtime });
}
