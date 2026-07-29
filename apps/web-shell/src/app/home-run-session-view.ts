import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type {
  ThreadMessage,
  ThreadSubagentTerminalOutcome,
} from '@geulbat/protocol/threads';

import type { AssistantProps } from '../features/assistant/Assistant.js';
import type { RunSessionViewModel } from './run-session-view-model.js';
import { createSubagentTerminalHistoryEntry } from './run-session-subagent-effect.js';

// HomeShell.tsx가 전부 만드는 셸 소유 projection. 시작 위치와 첨부 IO는
// 런 세션 상태가 아니므로 이 뷰에 섞지 않는다.
type ShellOwnedAssistantPropKey = keyof Pick<
  AssistantProps,
  'attachments' | 'workspace'
>;

// 이 세 projection은 런 세션과 셸이 각자의 소유 필드를 만든 뒤 HomeShell이
// 명시적으로 합친다. 새 필드가 생기면 아래 Omit 목록에 owner를 기록하거나
// 이 뷰에서 만들 때까지 컴파일이 깨진다.
type ShellCompletedAssistantPropKey = keyof Pick<
  AssistantProps,
  'artifacts' | 'composerSurface' | 'workflow'
>;

type HomeAssistantView = Required<
  Omit<
    AssistantProps,
    ShellOwnedAssistantPropKey | ShellCompletedAssistantPropKey
  >
> & {
  artifacts: Required<Omit<AssistantProps['artifacts'], 'onOpen'>>;
  composerSurface: Required<
    Omit<
      NonNullable<AssistantProps['composerSurface']>,
      | 'draftRequest'
      | 'imageProviderConnected'
      | 'onOpenSkills'
      | 'onOpenMcpSettings'
    >
  >;
  workflow: Required<
    Omit<NonNullable<AssistantProps['workflow']>, 'approvalPanel'>
  >;
  // 런 세션은 Assistant 계약보다 좁게 약속한다 — 셸과 테스트가 완료를
  // 기다릴 수 있도록 항상 Promise를 돌려준다.
  runActions: Omit<AssistantProps['runActions'], 'onEditPastUserPrompt'> & {
    onEditPastUserPrompt: (
      entryId: string,
      nextPrompt: string,
    ) => Promise<void>;
  };
};

interface HomeApprovalPanelView {
  pending: ApprovalRequired | null;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void> | void;
  onApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
    permissionMode?: PermissionMode,
  ) => Promise<void>;
  onDeny: (pending: ApprovalRequired) => Promise<void>;
}

// 홈 셸이 소비하지 않는 런 세션 필드 — 이름을 남겨 "안 쓰기로 했다"를 기록한다.
// activeRunId는 셸 화면에 나타나지 않고, isSettling은 아래에서 isRunSettling으로
// 이름을 바꿔 받는다(isRunStarting과 짝을 맞춘다).
type UnusedRunSessionViewModelKey = keyof Pick<
  RunSessionViewModel,
  'activeRunId' | 'isSettling'
>;

// RunSessionViewModel에서 파생한다. 손으로 베낀 목록이었을 때는 상류에 필드가
// 늘어도 여기서 조용히 멈췄다 — 컴파일은 통과하고 기능만 화면에 닿지 않았다.
// 이제 새 필드는 자동으로 흘러오고, 뺄 것은 위 목록에 이름을 남겨야 빠진다.
interface HomeRunSessionInput extends Omit<
  RunSessionViewModel,
  UnusedRunSessionViewModelKey
> {
  isRunSettling?: boolean;
}

interface HomeRunSessionView {
  assistant: HomeAssistantView;
  approvalPanel: HomeApprovalPanelView;
  // 생성 중인 아티팩트 봉투 라이브 텍스트 — HomeShell이 중앙 창에 흘린다.
  // Assistant prop이 아니므로 assistant 뷰에 섞이지 않는다.
  streamingArtifactText: string;
}

interface CreateHomeRunSessionViewArgs {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  subagentTerminalOutcomes: ThreadSubagentTerminalOutcome[];
  messageHistory?: NonNullable<AssistantProps['conversation']['history']>;
  branchFromMessage: (entryId: string) => Promise<void>;
  editPastUserPrompt: (entryId: string, nextPrompt: string) => Promise<void>;
  branchNotice: string | null;
  dismissBranchNotice: () => void;
  runSession: HomeRunSessionInput;
}

export function createHomeRunSessionView({
  messages,
  artifacts,
  subagentTerminalOutcomes,
  messageHistory,
  branchFromMessage,
  editPastUserPrompt,
  branchNotice,
  dismissBranchNotice,
  runSession,
}: CreateHomeRunSessionViewArgs): HomeRunSessionView {
  const isRunSettling = runSession.isRunSettling ?? false;

  return {
    assistant: {
      conversation: {
        threadId: runSession.visibleThreadId,
        messages,
        ...(messageHistory === undefined ? {} : { history: messageHistory }),
        transcriptEntries: runSession.transcriptEntries,
        finalAnswerText: runSession.finalAnswerText,
        branchNotice,
        onDismissBranchNotice: dismissBranchNotice,
      },
      activity: {
        backgroundNotifications: runSession.backgroundNotifications,
        subagentTerminalHistoryEntries: subagentTerminalOutcomes.map(
          createSubagentTerminalHistoryEntry,
        ),
        onStopChildRun: runSession.stopChildRun,
      },
      artifacts: {
        versions: artifacts,
        activeVersion: runSession.activeArtifact,
        onStartRun: runSession.startRunRequest,
        onWidgetPrompt: runSession.sendWidgetPrompt,
        onWidgetToolRequest: runSession.requestWidgetTool,
      },
      runState: {
        streamError: runSession.streamError,
        streamErrorCode: runSession.streamErrorCode,
        isRunning: runSession.isRunning,
        isStarting: runSession.isRunStarting,
        isSettling: isRunSettling,
        usageTotals: runSession.usageTotals,
        providerRuntime: runSession.providerRuntime,
        contextUsage: runSession.contextUsage,
      },
      runActions: {
        onSend: runSession.sendPrompt,
        onSendNewTurn: runSession.sendPromptAsNewTurn,
        onRegenerate: runSession.regeneratePrompt,
        onBranchFromMessage: branchFromMessage,
        onEditPastUserPrompt: editPastUserPrompt,
        onCancel: runSession.handleCancel,
        onPrepareProviderTransition: runSession.prepareProviderTransition,
      },
      steering: {
        pendingSteers: runSession.pendingSteers,
        onCancelSteer: runSession.cancelSteer,
        onFlushSteers: runSession.flushSteers,
        pendingSteerFlushRequested: runSession.pendingSteerFlushRequested,
      },
      composerControls: {
        permissionMode: runSession.permissionMode,
        onPermissionModeChange: runSession.setPermissionMode,
        planModeRequested: runSession.planModeRequested,
        onPlanModeRequestedChange: runSession.setPlanModeRequested,
        planModeIntensity: runSession.planModeIntensity,
        onPlanModeIntensityChange: runSession.setPlanModeIntensity,
        planModeDepth: runSession.planModeDepth,
        onPlanModeDepthChange: runSession.setPlanModeDepth,
        modelId: runSession.modelId,
        onModelIdChange: runSession.setModelId,
        reasoningEffort: runSession.reasoningEffort,
        onReasoningEffortChange: runSession.setReasoningEffort,
        serviceTier: runSession.serviceTier,
        onServiceTierChange: runSession.setServiceTier,
        subagentModelRouting: runSession.subagentModelRouting,
        onSubagentModelRoutingChange: runSession.setSubagentModelRouting,
      },
      workflow: {
        planningWorkflow: runSession.planningWorkflow,
        goal: runSession.goal,
      },
      composerSurface: {
        followupSuggestion: runSession.followupSuggestion,
        onDismissFollowupSuggestion: runSession.dismissFollowupSuggestion,
      },
    },
    approvalPanel: {
      pending: runSession.pendingApproval,
      permissionMode: runSession.permissionMode,
      onPermissionModeChange: runSession.setPermissionMode,
      onApprove: runSession.handleApprove,
      onDeny: runSession.handleDeny,
    },
    streamingArtifactText: runSession.streamingArtifactText,
  };
}
