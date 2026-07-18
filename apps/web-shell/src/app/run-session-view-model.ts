import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunAttachmentInput,
  RunModelId,
  RunReasoningEffort,
  RunRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';

// 위젯/아티팩트 프레임 발 도구 호출(run.tool) 실행기 — 신뢰 컨텍스트는
// 컨트롤러가 주입하고 프레임은 데이터만 준다.
export type RequestWidgetTool = (request: {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  scopeHandle: string;
}) => Promise<RunToolResultPayload>;

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
  | 'usageTotals'
  | 'contextUsage'
> {
  isRunStarting: boolean;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  modelId: RunModelId;
  setModelId: (modelId: RunModelId) => void;
  prepareProviderTransition: (targetModelId: RunModelId) => Promise<void>;
  reasoningEffort: RunReasoningEffort;
  setReasoningEffort: (effort: RunReasoningEffort) => void;
  subagentModelRouting: RunSubagentModelRouting;
  setSubagentModelRouting: (routing: RunSubagentModelRouting) => void;
  sendPrompt: (
    prompt: string,
    attachments?: RunAttachmentInput[],
  ) => Promise<void>;
  sendWidgetPrompt: (prompt: string) => Promise<void>;
  requestWidgetTool: RequestWidgetTool;
  regeneratePrompt: (prompt: string) => Promise<void>;
  cancelSteer: (receivedSeq: number) => Promise<void>;
  flushSteers: () => Promise<void>;
  pendingSteers: VisibleRunState['pendingSteers'];
  pendingSteerFlushRequested: VisibleRunState['pendingSteerFlushRequested'];
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
  modelId: RunModelId;
  setModelId: (modelId: RunModelId) => void;
  prepareProviderTransition: (targetModelId: RunModelId) => Promise<void>;
  reasoningEffort: RunReasoningEffort;
  setReasoningEffort: (effort: RunReasoningEffort) => void;
  subagentModelRouting: RunSubagentModelRouting;
  setSubagentModelRouting: (routing: RunSubagentModelRouting) => void;
  sendPrompt: (
    prompt: string,
    attachments?: RunAttachmentInput[],
  ) => Promise<void>;
  sendWidgetPrompt: (prompt: string) => Promise<void>;
  requestWidgetTool: RequestWidgetTool;
  regeneratePrompt: (prompt: string) => Promise<void>;
  cancelSteer: (receivedSeq: number) => Promise<void>;
  flushSteers: () => Promise<void>;
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
    modelId,
    setModelId,
    prepareProviderTransition,
    reasoningEffort,
    setReasoningEffort,
    subagentModelRouting,
    setSubagentModelRouting,
    streamError: visibleRunState.streamError,
    backgroundNotifications: visibleRunState.backgroundNotifications,
    usageTotals: visibleRunState.usageTotals,
    contextUsage: visibleRunState.contextUsage,
    sendPrompt,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    pendingSteers: visibleRunState.pendingSteers,
    pendingSteerFlushRequested: visibleRunState.pendingSteerFlushRequested,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  };
}
