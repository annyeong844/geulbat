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
import type {
  ContextUsageUpdatedEventPayload,
  RunUsageTotals,
} from '@geulbat/protocol/run-events';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';
import type { RequestWidgetTool } from './run-session-view-model.js';

interface HomeAssistantView {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  streamError: string | null;
  isRunning: boolean;
  isStarting: boolean;
  isSettling?: boolean;
  // 실행 중 상태줄에 표시할 런 누적 토큰 사용량
  usageTotals: RunUsageTotals | null;
  contextUsage: ContextUsageUpdatedEventPayload | null;
  onSend: (prompt: string, attachments?: RunAttachmentInput[]) => Promise<void>;
  // 위젯/프레임 발 request_prompt — 컴포저와 같은 전송 경로지만 턴을
  // 아티팩트 발로 귀속 렌더한다
  onWidgetPrompt: (prompt: string) => Promise<void>;
  onWidgetToolRequest: RequestWidgetTool;
  onRegenerate: (prompt: string) => Promise<void>;
  onBranchFromMessage: (entryId: string) => Promise<void>;
  // 과거 질문 편집 — 그 질문 직전까지 브랜치한 새 스레드에서 수정본으로 재실행
  onEditPastUserPrompt: (entryId: string, nextPrompt: string) => Promise<void>;
  branchNotice: string | null;
  onDismissBranchNotice: () => void;
  onCancelSteer: (receivedSeq: number) => Promise<void>;
  onFlushSteers: () => Promise<void>;
  pendingSteers: Array<{ receivedSeq: number; text: string }>;
  pendingSteerFlushRequested: boolean;
  onStartArtifactRun: (
    request: RunRequest,
    optimisticPrompt?: string,
  ) => Promise<void>;
  onCancel: () => Promise<void>;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  modelId: RunModelId;
  onModelIdChange: (modelId: RunModelId) => void;
  onPrepareProviderTransition: (targetModelId: RunModelId) => Promise<void>;
  reasoningEffort: RunReasoningEffort;
  onReasoningEffortChange: (effort: RunReasoningEffort) => void;
  subagentModelRouting: RunSubagentModelRouting;
  onSubagentModelRoutingChange: (routing: RunSubagentModelRouting) => void;
}

interface HomeApprovalPanelView {
  pending: ApprovalRequired | null;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
  ) => Promise<void>;
  onDeny: (pending: ApprovalRequired) => Promise<void>;
}

interface HomeRunSessionInput {
  isRunStarting: boolean;
  isRunning: boolean;
  isRunSettling?: boolean;
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  pendingApproval: ApprovalRequired | null;
  permissionMode: PermissionMode;
  modelId: RunModelId;
  reasoningEffort: RunReasoningEffort;
  subagentModelRouting: RunSubagentModelRouting;
  streamError: string | null;
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  usageTotals: RunUsageTotals | null;
  contextUsage: ContextUsageUpdatedEventPayload | null;
  setPermissionMode: (mode: PermissionMode) => void;
  setModelId: (modelId: RunModelId) => void;
  prepareProviderTransition: (targetModelId: RunModelId) => Promise<void>;
  setReasoningEffort: (effort: RunReasoningEffort) => void;
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
  pendingSteers: Array<{ receivedSeq: number; text: string }>;
  pendingSteerFlushRequested: boolean;
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

interface HomeRunSessionView {
  assistant: HomeAssistantView;
  approvalPanel: HomeApprovalPanelView;
}

interface CreateHomeRunSessionViewArgs {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  branchFromMessage: (entryId: string) => Promise<void>;
  editPastUserPrompt: (entryId: string, nextPrompt: string) => Promise<void>;
  branchNotice: string | null;
  dismissBranchNotice: () => void;
  runSession: HomeRunSessionInput;
}

export function createHomeRunSessionView({
  messages,
  artifacts,
  branchFromMessage,
  editPastUserPrompt,
  branchNotice,
  dismissBranchNotice,
  runSession,
}: CreateHomeRunSessionViewArgs): HomeRunSessionView {
  const isRunSettling = runSession.isRunSettling ?? false;

  return {
    assistant: {
      messages,
      artifacts,
      backgroundNotifications: runSession.backgroundNotifications,
      transcriptEntries: runSession.transcriptEntries,
      finalAnswerText: runSession.finalAnswerText,
      activeArtifact: runSession.activeArtifact,
      streamError: runSession.streamError,
      isRunning: runSession.isRunning,
      isStarting: runSession.isRunStarting,
      isSettling: isRunSettling,
      usageTotals: runSession.usageTotals,
      contextUsage: runSession.contextUsage,
      onSend: runSession.sendPrompt,
      onWidgetPrompt: runSession.sendWidgetPrompt,
      onWidgetToolRequest: runSession.requestWidgetTool,
      onRegenerate: runSession.regeneratePrompt,
      onBranchFromMessage: branchFromMessage,
      onEditPastUserPrompt: editPastUserPrompt,
      branchNotice,
      onDismissBranchNotice: dismissBranchNotice,
      onCancelSteer: runSession.cancelSteer,
      onFlushSteers: runSession.flushSteers,
      pendingSteers: runSession.pendingSteers,
      pendingSteerFlushRequested: runSession.pendingSteerFlushRequested,
      onStartArtifactRun: runSession.startRunRequest,
      onCancel: runSession.handleCancel,
      permissionMode: runSession.permissionMode,
      onPermissionModeChange: runSession.setPermissionMode,
      modelId: runSession.modelId,
      onModelIdChange: runSession.setModelId,
      onPrepareProviderTransition: runSession.prepareProviderTransition,
      reasoningEffort: runSession.reasoningEffort,
      onReasoningEffortChange: runSession.setReasoningEffort,
      subagentModelRouting: runSession.subagentModelRouting,
      onSubagentModelRoutingChange: runSession.setSubagentModelRouting,
    },
    approvalPanel: {
      pending: runSession.pendingApproval,
      permissionMode: runSession.permissionMode,
      onPermissionModeChange: runSession.setPermissionMode,
      onApprove: runSession.handleApprove,
      onDeny: runSession.handleDeny,
    },
  };
}
