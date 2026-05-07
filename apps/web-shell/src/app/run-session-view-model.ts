import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import {
  isRunSessionStarting,
  selectVisibleRunState,
} from './run-session-state-selectors.js';
import type {
  RunSessionState,
  VisibleRunState,
} from './run-session-state-types.js';

export interface RunSessionViewModel extends Pick<
  VisibleRunState,
  | 'visibleThreadId'
  | 'activeRunId'
  | 'isRunning'
  | 'isSettling'
  | 'transcriptEntries'
  | 'finalAnswerText'
  | 'activeArtifact'
  | 'pendingApproval'
  | 'streamError'
  | 'backgroundNotifications'
> {
  isRunStarting: boolean;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  sendPrompt: (prompt: string) => Promise<void>;
  startRunRequest: (
    request: RunRequest,
    optimisticPrompt?: string,
  ) => Promise<void>;
  handleApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
  ) => Promise<void>;
  handleDeny: (pending: ApprovalRequired) => Promise<void>;
  handleCancel: () => Promise<void>;
}

interface CreateRunSessionViewModelArgs {
  selectedThreadId: string | null;
  state: RunSessionState;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  sendPrompt: (prompt: string) => Promise<void>;
  startRunRequest: (
    request: RunRequest,
    optimisticPrompt?: string,
  ) => Promise<void>;
  handleApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
  ) => Promise<void>;
  handleDeny: (pending: ApprovalRequired) => Promise<void>;
  handleCancel: () => Promise<void>;
}

export function createRunSessionViewModel({
  selectedThreadId,
  state,
  permissionMode,
  setPermissionMode,
  sendPrompt,
  startRunRequest,
  handleApprove,
  handleDeny,
  handleCancel,
}: CreateRunSessionViewModelArgs): RunSessionViewModel {
  const visibleRunState = selectVisibleRunState({
    selectedThreadId,
    state,
  });

  return {
    visibleThreadId: visibleRunState.visibleThreadId,
    activeRunId: visibleRunState.activeRunId,
    isRunStarting: isRunSessionStarting(state),
    isRunning: visibleRunState.isRunning,
    isSettling: visibleRunState.isSettling,
    transcriptEntries: visibleRunState.transcriptEntries,
    finalAnswerText: visibleRunState.finalAnswerText,
    activeArtifact: visibleRunState.activeArtifact,
    pendingApproval: visibleRunState.pendingApproval,
    permissionMode,
    setPermissionMode,
    streamError: visibleRunState.streamError,
    backgroundNotifications: visibleRunState.backgroundNotifications,
    sendPrompt,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  };
}
