import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunAttachmentInput,
  RunModelId,
  RunReasoningSelection,
  RunRequest,
  RunServiceTier,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';
import type { PrepareProviderTransitionRequest } from '@geulbat/protocol/threads';
import type {
  PlanModeDepth,
  PlanModeIntensity,
  PlanningWorkflowSnapshot,
  PlanWorkflowCommand,
} from '@geulbat/protocol/planning-workflow';
import type { GoalCommand, GoalSnapshot } from '@geulbat/protocol/goal';

// 위젯/아티팩트 프레임 발 도구 호출(run.tool) 실행기 — 신뢰 컨텍스트는
// 컨트롤러가 주입하고 프레임은 데이터만 준다.
type RequestWidgetTool = (request: {
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

/**
 * 런 세션 런타임이 뷰로 변환 없이 흘려보내는 제어 표면 — 현재 선택값과 그
 * setter, 그리고 런/승인 명령이 그대로 지나간다. 한 곳에만 선언해서 필드
 * 하나를 늘릴 때 런타임 반환·뷰모델 인자·뷰모델 결과·중간 훅이 각각 손으로
 * 반복되지 않게 한다.
 */
interface RunSessionRuntimeControls {
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  planModeRequested: boolean;
  setPlanModeRequested: (planModeRequested: boolean) => void;
  planModeIntensity: PlanModeIntensity;
  setPlanModeIntensity: (intensity: PlanModeIntensity) => void;
  planModeDepth: PlanModeDepth;
  setPlanModeDepth: (depth: PlanModeDepth) => void;
  /** 다음 걸음 제안 — 저장하지 않는 그 턴의 표시값. 없으면 null. */
  followupSuggestion: string | null;
  dismissFollowupSuggestion: () => void;
  planningWorkflow: {
    snapshot: PlanningWorkflowSnapshot;
    busy: boolean;
    onCommand: (command: PlanWorkflowCommand) => Promise<void>;
  } | null;
  goal: {
    snapshot: GoalSnapshot;
    busy: boolean;
    onCommand: (command: GoalCommand) => Promise<void>;
  } | null;
  modelId: RunModelId;
  setModelId: (modelId: RunModelId) => void;
  prepareProviderTransition: (
    request: PrepareProviderTransitionRequest,
  ) => Promise<void>;
  reasoningEffort: RunReasoningSelection;
  setReasoningEffort: (effort: RunReasoningSelection) => void;
  serviceTier: RunServiceTier;
  setServiceTier: (serviceTier: RunServiceTier) => void;
  subagentModelRouting: RunSubagentModelRouting;
  setSubagentModelRouting: (routing: RunSubagentModelRouting) => void;
  sendPrompt: (
    prompt: string,
    attachments?: RunAttachmentInput[],
  ) => Promise<void>;
  sendPromptAsNewTurn: (prompt: string) => Promise<void>;
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
    permissionMode?: PermissionMode,
  ) => Promise<void>;
  handleDeny: (pending: ApprovalRequired) => Promise<void>;
  handleCancel: () => Promise<void>;
  stopChildRun: (request: {
    parentRunId: string;
    childRunId: string;
  }) => Promise<void>;
}

export interface RunSessionViewModel
  extends
    Pick<
      VisibleRunState,
      | 'visibleThreadId'
      | 'activeRunId'
      | 'isRunning'
      | 'isSettling'
      | 'transcriptEntries'
      | 'finalAnswerText'
      | 'activeArtifact'
      | 'streamingArtifactText'
      | 'pendingApproval'
      | 'streamError'
      | 'streamErrorCode'
      | 'backgroundNotifications'
      | 'usageTotals'
      | 'providerRuntime'
      | 'contextUsage'
    >,
    RunSessionRuntimeControls {
  isRunStarting: boolean;
  pendingSteers: VisibleRunState['pendingSteers'];
  pendingSteerFlushRequested: VisibleRunState['pendingSteerFlushRequested'];
}

/**
 * 뷰모델을 만드는 데 필요한 입력 전부. useRunSessionRuntime의 반환 계약이
 * 여기서 파생되므로(selectedThreadId만 셸이 얹는다), 이 목록이 곧 런 세션
 * 런타임이 제공해야 하는 것의 정본이다.
 */
export interface CreateRunSessionViewModelArgs extends RunSessionRuntimeControls {
  selectedThreadId: string | null;
  state: RunSessionState;
}

export function createRunSessionViewModel({
  selectedThreadId,
  state,
  ...controls
}: CreateRunSessionViewModelArgs): RunSessionViewModel {
  const visibleRunState = selectVisibleRunState({
    selectedThreadId,
    state,
  });

  return {
    visibleThreadId: visibleRunState.visibleThreadId,
    activeRunId: visibleRunState.activeRunId,
    isRunStarting: isRunSessionStarting(state, selectedThreadId),
    isRunning: visibleRunState.isRunning,
    isSettling: visibleRunState.isSettling,
    transcriptEntries: visibleRunState.transcriptEntries,
    finalAnswerText: visibleRunState.finalAnswerText,
    activeArtifact: visibleRunState.activeArtifact,
    streamingArtifactText: visibleRunState.streamingArtifactText,
    pendingApproval: visibleRunState.pendingApproval,
    streamError: visibleRunState.streamError,
    streamErrorCode: visibleRunState.streamErrorCode,
    backgroundNotifications: visibleRunState.backgroundNotifications,
    usageTotals: visibleRunState.usageTotals,
    providerRuntime: visibleRunState.providerRuntime,
    contextUsage: visibleRunState.contextUsage,
    pendingSteers: visibleRunState.pendingSteers,
    pendingSteerFlushRequested: visibleRunState.pendingSteerFlushRequested,
    ...controls,
  };
}
