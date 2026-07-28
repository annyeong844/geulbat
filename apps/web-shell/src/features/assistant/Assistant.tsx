import React, { useCallback, useMemo, useState } from 'react';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type {
  RunAttachmentInput,
  RunRequest,
} from '@geulbat/protocol/run-contract';
import {
  DEFAULT_RUN_SERVICE_TIER,
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  resolveMaximumReasoningEffort,
} from '@geulbat/protocol/run-contract';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import { isSamePlanRenderingStamp } from '@geulbat/protocol/planning-workflow';
import type {
  PrepareProviderTransitionRequest,
  ThreadMessage,
} from '@geulbat/protocol/threads';
import { isSilentUserMessage } from '../../lib/silent-user-message.js';

import type {
  ContextUsageUpdatedEventPayload,
  ProviderRuntimeStatusEventPayload,
  RunUsageTotals,
} from '@geulbat/protocol/run-events';
import {
  appendSubagentTranscriptEntry,
  type RunTranscriptEntry,
} from '../../lib/run-transcript-entry.js';
import {
  AssistantComposer,
  type AssistantComposerControls,
  type AssistantComposerDraftRequest,
  type ComposerAttachment,
} from './AssistantComposer.js';
export type { AssistantComposerControls };
import { AssistantTranscript } from './AssistantTranscript.js';
import { PendingSteerList } from './PendingSteerList.js';
import type {
  TranscriptMessageEditActions,
  TranscriptRowInteractions,
} from './assistant-transcript-virtual-list.js';
import type { WidgetToolRequestHandler } from './visualize/visualize-widget.js';
import { readVisualizeWidgetViewFromToolCallContent } from './visualize/visualize-widget-view.js';
import { assistantStyles } from './assistant-styles.js';
import { AssistantActivityShelf } from './assistant-activity-shelf.js';
import {
  ChildSessionViewer,
  type ChildSessionTarget,
} from './ChildSessionViewer.js';
import { ProviderTransitionDialog } from './provider-transition-dialog.js';
import {
  resolveLatestLiveRunPlan,
  resolveRunPlanHistory,
} from './run-plan/run-plan.js';
import { useAssistantProviderTransition } from './use-assistant-provider-transition.js';
import { useAskUserAnswerHandoff } from './use-ask-user-answer-handoff.js';
import { useComposerAttachments } from './use-composer-attachments.js';
import {
  type AssistantWorkspace,
  useWorkingDirectoryPicker,
} from './use-working-directory-picker.js';
import { WorkingDirectoryPickerDialog } from './working-directory-picker-dialog.js';
import {
  PlanningWorkflowCard,
  type AssistantPlanningWorkflow,
} from './run-plan/planning-workflow-card.js';
import { GoalStatusCard, type AssistantGoal } from './goal-status-card.js';

// HomeShell은 런 세션 뷰를 통째로 spread해 이 컴포넌트에 넘긴다. 그래서
// 여기 prop이 늘어나도 배선 누락은 타입이 아니라 "화면에서 조용히 사라짐"으로
// 드러난다. 뷰 쪽(home-run-session-view.ts)이 이 타입에서 파생되도록 공개한다.
// 대기 중 스티어 큐 한 벌 — 큐·취소·즉시반영이 함께 움직인다.
interface AssistantSteering {
  pendingSteers: Array<{ receivedSeq: number; text: string }>;
  onCancelSteer?: (receivedSeq: number) => Promise<void> | void;
  // 지금 반영 — 다음 라운드를 기다리지 않고 큐를 즉시 소비 지점으로
  onFlushSteers?: () => Promise<void> | void;
  pendingSteerFlushRequested?: boolean;
}

interface AssistantConversation {
  threadId?: string | null;
  messages: ThreadMessage[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  // 브랜치 성공 알림 — 전환이 화면상 티가 안 나므로 명시적으로 알린다.
  branchNotice?: string | null;
  onDismissBranchNotice?: () => void;
}

interface AssistantActivity {
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  subagentTerminalHistoryEntries?: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  onStopChildRun?: (request: {
    parentRunId: string;
    childRunId: string;
  }) => Promise<void> | void;
}

interface AssistantArtifacts {
  versions?: ThreadArtifactVersion[];
  activeVersion?: ThreadArtifactVersion | null;
  onStartRun: (request: RunRequest) => Promise<void> | void;
  // 존재하면 아티팩트는 채팅 인라인 대신 참조 칩 + 중앙 패널로 흐른다.
  onOpen?: (artifact: ThreadArtifactVersion) => void;
  // 위젯/프레임 발 request_prompt — 전송 경로는 onSend와 같지만 턴을
  // 아티팩트 발로 귀속 렌더한다. 없으면 onSend로 폴백(무귀속).
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출(run.tool) — 컨트롤러가 신뢰 컨텍스트를 주입해 실행.
  onWidgetToolRequest?: WidgetToolRequestHandler;
}

interface AssistantRunState {
  streamError: string | null;
  streamErrorCode?: ErrorCode | null;
  isRunning: boolean;
  isStarting?: boolean;
  isSettling?: boolean;
  usageTotals?: RunUsageTotals | null;
  providerRuntime?: ProviderRuntimeStatusEventPayload | null;
  contextUsage?: ContextUsageUpdatedEventPayload | null;
}

interface AssistantRunActions {
  onSend: (
    prompt: string,
    attachments?: RunAttachmentInput[],
  ) => Promise<void> | void;
  // ask_user처럼 반드시 다음 사용자 턴이어야 하는 입력. 제품 배선에서는
  // 활성 run 발견 시 interject하지 않고 거부한다.
  onSendNewTurn?: (prompt: string) => Promise<void> | void;
  // 답변 재생성(덮어쓰기) — 없으면 onSend 재전송(새 턴 추가)으로 동작
  onRegenerate?: (prompt: string) => Promise<void> | void;
  // ⑂ 여기서 새 채팅 — 해당 답변까지의 prefix를 복제한 새 스레드로 전환
  onBranchFromMessage?: (entryId: string) => Promise<void> | void;
  // 과거 질문 편집 — 직전까지 브랜치한 새 스레드에서 수정본으로 재실행
  onEditPastUserPrompt?: (
    entryId: string,
    nextPrompt: string,
  ) => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  // 컴포저 컨트롤이 아니라 제공자 전환 훅의 의존이다 — 모델을 바꾸다 문맥
  // 한계에 걸렸을 때만 쓰이므로 컨트롤 한 벌과 함께 움직이지 않는다.
  onPrepareProviderTransition?: (
    request: PrepareProviderTransitionRequest,
  ) => Promise<void>;
}

interface AssistantAttachments {
  onUploadFiles?: (files: FileList) => Promise<ComposerAttachment[]>;
  onDiscardUploadedAttachment?: (contentRef: string) => void;
  imageUrl?: (attachmentId: string) => string | null;
}

interface AssistantWorkflow {
  approvalPanel?: React.ReactNode;
  planningWorkflow?: AssistantPlanningWorkflow | null;
  goal?: AssistantGoal | null;
}

interface AssistantComposerSurface {
  draftRequest?: AssistantComposerDraftRequest | null;
  /** 다음 걸음 제안 — 명확할 때만 온다. 저장하지 않는다. */
  followupSuggestion?: string | null;
  onDismissFollowupSuggestion?: () => void;
  onOpenSkills?: () => void;
  onOpenMcpSettings?: () => void;
  // [+] 메뉴 이미지 서브패널의 프로바이더 연결 상태.
  imageProviderConnected?: {
    grok_oauth?: boolean;
    openai_codex_direct?: boolean;
  };
}

export interface AssistantProps {
  conversation: AssistantConversation;
  activity: AssistantActivity;
  artifacts: AssistantArtifacts;
  runState: AssistantRunState;
  runActions: AssistantRunActions;
  // 대기 중 스티어 큐 + 취소/반영 — 있으면 입력창 위에 큐 행을 그린다.
  steering?: AssistantSteering;
  composerControls?: AssistantComposerControls;
  // 시작 위치 선택 — 값·브라우즈·선택 핸들러 한 벌. 부분 지정 가능(나머지는
  // 기본값). 전체 형태는 useWorkingDirectoryPicker 입력(AssistantWorkspace).
  workspace?: Partial<AssistantWorkspace>;
  attachments?: AssistantAttachments;
  workflow?: AssistantWorkflow;
  composerSurface?: AssistantComposerSurface;
}

// 컨트롤을 넘기지 않는 호출자(대부분의 테스트)가 쓰는 기본 한 벌. 훅 의존에
// 들어가므로 모듈 수준에서 한 번만 만들어 신원을 고정한다.
const DEFAULT_COMPOSER_CONTROLS: AssistantComposerControls = {
  permissionMode: 'basic',
  onPermissionModeChange: () => {},
  planModeRequested: false,
  onPlanModeRequestedChange: () => {},
  planModeIntensity: 'visual',
  onPlanModeIntensityChange: () => {},
  planModeDepth: 'standard',
  onPlanModeDepthChange: () => {},
  modelId: 'gpt-5.6-sol',
  onModelIdChange: () => {},
  reasoningEffort: 'medium',
  onReasoningEffortChange: () => {},
  serviceTier: DEFAULT_RUN_SERVICE_TIER,
  onServiceTierChange: () => {},
  subagentModelRouting: DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  onSubagentModelRoutingChange: () => {},
};

const EMPTY_ARTIFACTS: ThreadArtifactVersion[] = [];
const EMPTY_PENDING_STEERS: Array<{ receivedSeq: number; text: string }> = [];
const EMPTY_SUBAGENT_HISTORY: Extract<
  RunTranscriptEntry,
  { kind: 'subagent_activity' }
>[] = [];
// workspace 번들을 안 넘기는 호출자(대부분의 테스트)가 쓰는 기본 한 벌.
const EMPTY_WORKSPACE: AssistantWorkspace = {
  workingDirectory: null,
  browseEnabled: false,
  browsePath: '',
  browseStartPath: '',
  browseShortcuts: [],
  onSelectWorkingDirectory: undefined,
  onChooseWorkingDirectory: undefined,
};

export function Assistant({
  conversation,
  activity,
  artifacts: artifactInput,
  runState,
  runActions,
  steering,
  composerControls = DEFAULT_COMPOSER_CONTROLS,
  workspace,
  attachments: attachmentControls,
  workflow,
  composerSurface,
}: AssistantProps) {
  const {
    threadId = null,
    messages,
    transcriptEntries,
    finalAnswerText,
    branchNotice = null,
    onDismissBranchNotice,
  } = conversation;
  const {
    backgroundNotifications,
    subagentTerminalHistoryEntries = EMPTY_SUBAGENT_HISTORY,
    onStopChildRun,
  } = activity;
  const {
    versions: artifacts = EMPTY_ARTIFACTS,
    activeVersion: activeArtifact = null,
    onStartRun: onStartArtifactRun,
    onOpen: onOpenArtifact,
    onWidgetPrompt,
    onWidgetToolRequest,
  } = artifactInput;
  const {
    streamError,
    streamErrorCode = null,
    isRunning,
    isStarting = false,
    isSettling = false,
    usageTotals = null,
    providerRuntime = null,
    contextUsage = null,
  } = runState;
  const {
    onSend,
    onSendNewTurn,
    onRegenerate,
    onBranchFromMessage,
    onEditPastUserPrompt,
    onCancel,
    onPrepareProviderTransition,
  } = runActions;
  const {
    onUploadFiles,
    onDiscardUploadedAttachment,
    imageUrl: attachmentImageUrl,
  } = attachmentControls ?? {};
  const {
    approvalPanel = null,
    planningWorkflow = null,
    goal = null,
  } = workflow ?? {};
  const {
    draftRequest: composerDraftRequest = null,
    followupSuggestion = null,
    onDismissFollowupSuggestion,
    onOpenSkills,
    onOpenMcpSettings,
    imageProviderConnected,
  } = composerSurface ?? {};
  // 열려 있는 차일드 세션 드릴다운 대상 (없으면 닫힘)
  const [childSessionTarget, setChildSessionTarget] =
    useState<ChildSessionTarget | null>(null);
  // 다음 메시지에 실을 첨부 — 업로드된 ref를 들고 있다가 전송 시 소비
  const {
    attachments,
    uploadPending,
    uploadFiles,
    removeAttachment: handleRemoveAttachment,
    clear: clearAttachments,
  } = useComposerAttachments({ onUploadFiles, onDiscardUploadedAttachment });
  const {
    handleAskUserAnswer,
    answeredAskUserRequestKeys,
    askUserAnswerPending,
  } = useAskUserAnswerHandoff({
    threadId,
    isRunning,
    isStarting,
    isSettling,
    sendNewTurn: onSendNewTurn ?? onSend,
  });
  // 시작 중에는 아직 steer 대상 run이 확정되지 않았다. 실제 running일 때만
  // 실행 중 입력을 열어 run.interject로 보낸다.
  const isBusy = isStarting || isSettling || askUserAnswerPending;
  const canInterject =
    isRunning && !isStarting && !isSettling && !askUserAnswerPending;
  // 번들 언팩 — 렌더는 기존 로컬 이름을 그대로 쓴다
  const workspaceInput = { ...EMPTY_WORKSPACE, ...workspace };
  const workingDirectoryPicker = useWorkingDirectoryPicker(workspaceInput);
  // 3단 구성: 컴포저 위의 바가 보낸 말들을 모아 두고(1), 거기서 즉시 반영으로
  // 큐 전체를 앞당기고(2), 대화에서 반짝이는 그 말풍선을 누르면 바로
  // 적용된다(3). 셋은 같은 큐를 다른 거리에서 다룬다.
  const pendingSteers = steering?.pendingSteers ?? EMPTY_PENDING_STEERS;
  const onCancelSteer = steering?.onCancelSteer;
  const onFlushSteers = steering?.onFlushSteers;
  const pendingSteerFlushRequested =
    steering?.pendingSteerFlushRequested ?? false;

  // 끝난 계획 카드는 스스로 사라지지 않는다 — 무엇을 승인해 실행했는지는
  // 기록이다. 대신 사용자가 치울 수 있게 둔다. revision과 state를 키에 담아,
  // 같은 계획이 다시 진행되면 새 카드로 다시 나타난다.
  const planCardKey =
    planningWorkflow === null
      ? null
      : `${planningWorkflow.snapshot.workflowId}:${
          'revision' in planningWorkflow.snapshot
            ? (planningWorkflow.snapshot.revision ?? 0)
            : 0
        }:${planningWorkflow.snapshot.state}`;
  const [dismissedPlanCardKey, setDismissedPlanCardKey] = useState<
    string | null
  >(null);

  // silent 사용자 턴(아티팩트 ♻ 등 UI 발 자동 요청)은 채팅에도, 재시도/편집
  // 대상에도 넣지 않는다.
  const visibleMessages = useMemo(
    () => messages.filter((message) => !isSilentUserMessage(message)),
    [messages],
  );
  // 과거 런의 서브에이전트 종료 카드는 그 런의 최종 답변 메시지 위에
  // 귀속시킨다 — 라이브 영역 끝에 눌어붙어 매 턴 다시 그려지지 않도록
  // (오너 결정 2026-07-23). 실행 중 라이브 카드는 활동 선반이 owner라
  // 트랜스크립트에서는 빼고, 귀속할 답변을 못 찾은 종료 카드만 기존처럼
  // 라이브 영역 끝에 남긴다.
  const { anchoredSubagentEntries, transcriptEntriesWithTerminalHistory } =
    useMemo(() => {
      let terminalEntries: RunTranscriptEntry[] = [];
      for (const entry of subagentTerminalHistoryEntries) {
        terminalEntries = appendSubagentTranscriptEntry(terminalEntries, entry);
      }
      for (const entry of backgroundNotifications) {
        if (
          entry.parentRunId !== undefined &&
          entry.state !== 'spawned' &&
          entry.state !== 'approval_required'
        ) {
          terminalEntries = appendSubagentTranscriptEntry(
            terminalEntries,
            entry,
          );
        }
      }
      const anchorMessageKeyByRunId = new Map<string, string>();
      for (const message of visibleMessages) {
        if (
          message.role === 'assistant' &&
          message.metadata?.phase === 'final_answer' &&
          message.metadata.sourceRunId !== undefined &&
          !anchorMessageKeyByRunId.has(message.metadata.sourceRunId)
        ) {
          anchorMessageKeyByRunId.set(
            message.metadata.sourceRunId,
            message.entryId,
          );
        }
      }
      const anchored = new Map<
        string,
        Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>[]
      >();
      const anchoredChildRunIds = new Set<string>();
      const orphanEntries: Extract<
        RunTranscriptEntry,
        { kind: 'subagent_activity' }
      >[] = [];
      for (const entry of terminalEntries) {
        if (entry.kind !== 'subagent_activity') {
          continue;
        }
        const anchorKey =
          entry.parentRunId === undefined
            ? undefined
            : anchorMessageKeyByRunId.get(entry.parentRunId);
        if (anchorKey === undefined) {
          orphanEntries.push(entry);
          continue;
        }
        anchoredChildRunIds.add(entry.childRunId);
        const bucket = anchored.get(anchorKey);
        if (bucket === undefined) {
          anchored.set(anchorKey, [entry]);
        } else {
          bucket.push(entry);
        }
      }
      let entries = isRunning
        ? transcriptEntries.filter(
            (entry) => entry.kind !== 'subagent_activity',
          )
        : transcriptEntries.filter(
            (entry) =>
              entry.kind !== 'subagent_activity' ||
              !anchoredChildRunIds.has(entry.childRunId),
          );
      for (const entry of orphanEntries) {
        entries = appendSubagentTranscriptEntry(entries, entry);
      }
      return {
        anchoredSubagentEntries: anchored,
        transcriptEntriesWithTerminalHistory: entries,
      };
    }, [
      backgroundNotifications,
      isRunning,
      subagentTerminalHistoryEntries,
      transcriptEntries,
      visibleMessages,
    ]);

  // 답변 다시 시도 — 마지막 사용자 프롬프트를 재생성(onRegenerate: 이전
  // 답변을 덮어씀)으로 재실행한다. 재생성 경로가 없으면 onSend 재전송(새
  // 턴 추가) 폴백. 텍스트 전용 — 원 첨부 contentRef는 소비되어 재전송하지
  // 않는다.
  const lastMessage = visibleMessages.at(-1);
  const lastUserPrompt = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index];
      if (message?.role === 'user' && message.content.trim()) {
        return message.content;
      }
    }
    return undefined;
  }, [visibleMessages]);
  const planningWorkflowOwnsRetry =
    planningWorkflow?.snapshot.state === 'awaiting_approval' ||
    planningWorkflow?.snapshot.state === 'approved_pending_publish' ||
    planningWorkflow?.snapshot.state === 'approved' ||
    planningWorkflow?.snapshot.state === 'executing' ||
    planningWorkflow?.snapshot.state === 'execution_failed';
  const canRetryLastPrompt =
    !isRunning &&
    !isBusy &&
    !planningWorkflowOwnsRetry &&
    lastUserPrompt !== undefined &&
    (lastMessage?.role === 'assistant' || streamError !== null);
  const {
    pendingProviderTransition,
    providerTransitionRecoveryRequired,
    providerTransitionPending,
    providerTransitionError,
    requestModelChange,
    cancelProviderTransition,
    confirmProviderTransition,
  } = useAssistantProviderTransition({
    threadId,
    messageCount: messages.length,
    modelId: composerControls.modelId,
    reasoningEffort:
      composerControls.reasoningEffort === 'ultra'
        ? resolveMaximumReasoningEffort(composerControls.modelId)
        : composerControls.reasoningEffort,
    isRunning,
    isStarting,
    isBusy,
    streamError,
    streamErrorCode,
    lastUserPrompt,
    onModelIdChange: composerControls.onModelIdChange,
    onPrepareProviderTransition,
    onRegenerate,
    onSend,
  });
  const retryLastPrompt = useCallback(() => {
    if (!canRetryLastPrompt || lastUserPrompt === undefined) {
      return;
    }
    void (onRegenerate ?? onSend)(lastUserPrompt);
  }, [canRetryLastPrompt, lastUserPrompt, onRegenerate, onSend]);

  // 질문 수정 — 마지막 질문을 인라인으로 고쳐 재생성으로 다시 보낸다.
  // 데몬이 마지막 사용자 턴을 잘라내므로 수정본이 그 자리를 대체한다.
  const canEditLastUserPrompt =
    !isRunning && !isBusy && lastUserPrompt !== undefined;
  const editLastUserPrompt = useCallback(
    (nextPrompt: string) => {
      if (!canEditLastUserPrompt) {
        return;
      }
      void (onRegenerate ?? onSend)(nextPrompt);
    },
    [canEditLastUserPrompt, onRegenerate, onSend],
  );

  // 여기서 새 채팅 — 실행 중에는 스레드 전환이 런 뷰와 얽히므로 닫아둔다.
  // (브랜치 API 자체는 active run에도 안전하다 — settle된 prefix만 복제)
  const canBranchFromMessage =
    onBranchFromMessage !== undefined && !isRunning && !isBusy;
  const branchFromMessage = useCallback(
    (entryId: string) => {
      if (!canBranchFromMessage || onBranchFromMessage === undefined) {
        return;
      }
      void onBranchFromMessage(entryId);
    },
    [canBranchFromMessage, onBranchFromMessage],
  );

  // 과거 질문 편집 — 브랜치+재실행이 얽히므로 실행 중에는 닫아둔다
  const canEditPastUserPrompt =
    onEditPastUserPrompt !== undefined && !isRunning && !isBusy;
  const editPastUserPrompt = useCallback(
    (entryId: string, nextPrompt: string) => {
      if (!canEditPastUserPrompt || onEditPastUserPrompt === undefined) {
        return;
      }
      void onEditPastUserPrompt(entryId, nextPrompt);
    },
    [canEditPastUserPrompt, onEditPastUserPrompt],
  );

  // 진행 상황 체크리스트 — live update_plan이 있으면 그것이 현재 계획이고,
  // 없으면 아직 final answer로 닫히지 않은 settled 호출만 사용한다.
  //
  // 비싼 계산과 싼 계산을 서로 다른 의존에 묶는다. settled 기록 전체를 훑는
  // `resolveRunPlanHistory`는 `messages`만 보므로 스트리밍 델타로 다시 돌 이유가
  // 없다. 반면 라이브 엔트리 역방향 조회는 현재 런 안에서만 돌아 저렴하다
  // (`transcriptEntries`는 런/스레드 전환에서 `createEmptyActiveRunView`로 새로
  // 시작한다). 둘을 한 memo에 두면 토큰이 도착할 때마다 기록 전체를 다시 훑는데,
  // 계획을 쓰지 않는 대화에서는 그것이 매 델타의 순수 헛일이 된다.
  const settledPendingRunPlan = useMemo(
    () => resolveRunPlanHistory(messages).pendingPlan,
    [messages],
  );
  const activeRunPlan = useMemo(() => {
    const plan =
      resolveLatestLiveRunPlan(transcriptEntries) ?? settledPendingRunPlan;
    return plan?.some((step) => step.status !== 'completed') ? plan : null;
  }, [settledPendingRunPlan, transcriptEntries]);
  const planningWorkflowSnapshot = planningWorkflow?.snapshot ?? null;
  const planningVisualization = useMemo(() => {
    const snapshot = planningWorkflowSnapshot;
    if (snapshot?.state !== 'awaiting_approval') {
      return null;
    }
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const message = visibleMessages[index];
      if (message?.role !== 'tool_call') {
        continue;
      }
      const view = readVisualizeWidgetViewFromToolCallContent(message.content);
      if (
        view?.planStamp !== undefined &&
        isSamePlanRenderingStamp(view.planStamp, snapshot)
      ) {
        return view;
      }
    }
    return null;
  }, [planningWorkflowSnapshot, visibleMessages]);

  const backgroundWorkEntries = useMemo(() => {
    const activeBackgroundParentRunIds = new Set(
      backgroundNotifications
        .filter(
          (entry) =>
            entry.state === 'spawned' || entry.state === 'approval_required',
        )
        .flatMap((entry) =>
          entry.parentRunId === undefined ? [] : [entry.parentRunId],
        ),
    );
    const byChildRunId = new Map<
      string,
      Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>
    >();
    for (const entry of backgroundNotifications) {
      if (
        entry.state === 'spawned' ||
        entry.state === 'approval_required' ||
        (entry.parentRunId !== undefined &&
          activeBackgroundParentRunIds.has(entry.parentRunId))
      ) {
        byChildRunId.set(entry.childRunId, entry);
      }
    }
    for (const entry of transcriptEntries) {
      if (entry.kind === 'subagent_activity') {
        byChildRunId.set(entry.childRunId, entry);
      }
    }
    return [...byChildRunId.values()];
  }, [backgroundNotifications, transcriptEntries]);
  const hasActiveChild = backgroundWorkEntries.some(
    (entry) => entry.state === 'spawned' || entry.state === 'approval_required',
  );
  // 부모 답변이 끝나도 살아 있는 child와 미완료 계획은 계속 관리한다.
  // 반대로 모두 끝난 과거 묶음은 다시 mount하지 않는다.
  const activityShelfPlan = isRunning || hasActiveChild ? activeRunPlan : null;
  const activityShelfEntries =
    isRunning || hasActiveChild ? backgroundWorkEntries : [];

  const handleSend = useCallback(
    async (input: string): Promise<boolean> => {
      const text = input.trim();
      if ((!text && attachments.length === 0) || isBusy || uploadPending) {
        return false;
      }
      // 첨부만 보낼 때도 daemon은 비어 있지 않은 prompt를 요구한다
      const prompt = text || '첨부한 파일을 확인해 주세요.';
      const runAttachments: RunAttachmentInput[] = attachments.map(
        (attachment) => ({
          name: attachment.name,
          contentRef: attachment.contentRef,
          ...(attachment.mimeType !== undefined
            ? { mimeType: attachment.mimeType }
            : {}),
        }),
      );
      try {
        await onSend(
          prompt,
          runAttachments.length > 0 ? runAttachments : undefined,
        );
        clearAttachments();
        return true;
      } catch {
        return false;
      }
    },
    [attachments, clearAttachments, isBusy, onSend, uploadPending],
  );

  // 행 계층으로 내려가는 상호작용 표면 — VirtualizedTranscriptRows와 행
  // 콘텐츠가 React.memo이므로 객체 identity를 렌더마다 새로 만들지 않는다.
  const transcriptRowInteractions = useMemo<TranscriptRowInteractions>(
    () => ({
      onStartArtifactRun,
      ...(attachmentImageUrl !== undefined ? { attachmentImageUrl } : {}),
      onOpenChildSession: setChildSessionTarget,
      // visualize 위젯의 sendPrompt — 컴포저와 같은 전송 경로로 합류시켜
      // 실행 중이면 스티어, 아니면 새 턴이 된다. 전용 경로가 배선되면
      // 턴이 아티팩트 발로 귀속 렌더된다.
      onWidgetPrompt: onWidgetPrompt ?? onSend,
      // 아직 읽히지 않은 내 말 되돌리기 — 그 말풍선이 가진 동작이다
      ...(onCancelSteer === undefined
        ? {}
        : {
            onCancelPendingSteer: (receivedSeq: number) => {
              void onCancelSteer(receivedSeq);
            },
          }),
      // 반짝이는 말풍선을 누르면 지금 반영 — 앞당길 대상과 버튼을 한 자리에
      ...(onFlushSteers === undefined
        ? {}
        : {
            onFlushPendingSteer: () => {
              void onFlushSteers();
            },
          }),
      // ask_user 답변은 현재 run이 done/settle된 뒤 정확히 한 번의 새
      // 사용자 턴으로 보낸다. 실행 중 스티어 경로로는 보내지 않는다.
      onAskUserAnswer: handleAskUserAnswer,
      answeredAskUserRequestKeys,
      ...(onWidgetToolRequest !== undefined ? { onWidgetToolRequest } : {}),
      ...(onOpenArtifact !== undefined ? { onOpenArtifact } : {}),
    }),
    [
      answeredAskUserRequestKeys,
      attachmentImageUrl,
      handleAskUserAnswer,
      onCancelSteer,
      onFlushSteers,
      onOpenArtifact,
      onSend,
      onStartArtifactRun,
      onWidgetPrompt,
      onWidgetToolRequest,
      setChildSessionTarget,
    ],
  );
  // 표시 조건은 여기서 판정한다 — 조건이 거짓이면 콜백을 넣지 않아 행이
  // 해당 액션을 그리지 않는다.
  const transcriptMessageEditActions = useMemo<TranscriptMessageEditActions>(
    () => ({
      ...(canRetryLastPrompt ? { onRetryLastPrompt: retryLastPrompt } : {}),
      ...(canEditLastUserPrompt
        ? { onEditLastUserPrompt: editLastUserPrompt }
        : {}),
      ...(canBranchFromMessage
        ? { onBranchFromMessage: branchFromMessage }
        : {}),
      ...(canEditPastUserPrompt
        ? { onEditPastUserPrompt: editPastUserPrompt }
        : {}),
    }),
    [
      branchFromMessage,
      canBranchFromMessage,
      canEditLastUserPrompt,
      canEditPastUserPrompt,
      canRetryLastPrompt,
      editLastUserPrompt,
      editPastUserPrompt,
      retryLastPrompt,
    ],
  );

  return (
    <section className="assistant" style={assistantStyles.section}>
      <AssistantTranscript
        threadId={threadId}
        messages={visibleMessages}
        artifacts={artifacts}
        transcriptEntries={transcriptEntriesWithTerminalHistory}
        anchoredSubagentEntries={anchoredSubagentEntries}
        finalAnswerText={finalAnswerText}
        activeArtifact={activeArtifact}
        planningWorkflowSnapshot={planningWorkflow?.snapshot ?? null}
        streamError={streamError}
        isRunning={isRunning}
        usageTotals={usageTotals}
        providerRuntime={providerRuntime}
        rowInteractions={transcriptRowInteractions}
        messageEditActions={transcriptMessageEditActions}
      />

      {childSessionTarget !== null ? (
        <ChildSessionViewer
          target={childSessionTarget}
          onClose={() => setChildSessionTarget(null)}
        />
      ) : null}

      {branchNotice !== null ? (
        <div className="branch-notice" role="status">
          <span className="branch-notice-text">{branchNotice}</span>
          {onDismissBranchNotice !== undefined ? (
            <button
              type="button"
              className="branch-notice-dismiss"
              aria-label="브랜치 알림 닫기"
              onClick={onDismissBranchNotice}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      <WorkingDirectoryPickerDialog overlay={workingDirectoryPicker.overlay} />

      {/* 계획/승인/스티어·컨텍스트·셸프·컴포저를 같은 읽기 컬럼에 묶는다.
          채팅만 모드처럼 패널이 넓어져도 본문·카드·입력이 서로 다른 폭으로
          어긋나지 않게 한다. */}
      <div className="composer-region">
        {approvalPanel}
        {planningWorkflow === null ||
        planCardKey === dismissedPlanCardKey ? null : (
          <PlanningWorkflowCard
            key={planCardKey}
            workflow={planningWorkflow}
            visualization={planningVisualization}
            onWidgetPrompt={onWidgetPrompt ?? onSend}
            {...(planCardKey === null
              ? {}
              : { onDismiss: () => setDismissedPlanCardKey(planCardKey) })}
          />
        )}
        {goal === null ? null : (
          <GoalStatusCard
            key={`${goal.snapshot.goalId}:${goal.snapshot.state}`}
            goal={goal}
          />
        )}

        {onCancelSteer !== undefined ? (
          <PendingSteerList
            steers={pendingSteers}
            flushRequested={pendingSteerFlushRequested}
            onCancel={(receivedSeq) => {
              void onCancelSteer(receivedSeq);
            }}
            {...(onFlushSteers !== undefined
              ? {
                  onFlush: () => {
                    void onFlushSteers();
                  },
                }
              : {})}
          />
        ) : null}

        {/* 컨텍스트 줄 — 어시스턴트가 보고 있는 시작 위치. 클릭 = 위치 변경.
          활동 셸프(진행 상황)가 떠 있는 동안은 숨긴다 — 카드 위에 떠서
          시각 소음이 된다. 셸프가 컴포저 바로 위 계약을 갖는다. */}
        {activityShelfPlan === null && activityShelfEntries.length === 0 ? (
          <button
            type="button"
            className="composer-context-bar"
            title={`시작 위치: ${workingDirectoryPicker.contextLabel}`}
            disabled={
              !workingDirectoryPicker.canChange ||
              isBusy ||
              canInterject ||
              workingDirectoryPicker.selectionPending
            }
            onClick={workingDirectoryPicker.openPicker}
          >
            <span className="composer-context-bar-icon" aria-hidden="true">
              ⌂
            </span>
            <span className="composer-context-bar-label">
              {workingDirectoryPicker.contextLabel}
            </span>
          </button>
        ) : null}

        {activityShelfPlan !== null || activityShelfEntries.length > 0 ? (
          <AssistantActivityShelf
            plan={activityShelfPlan}
            entries={activityShelfEntries}
            isRunning={isRunning || hasActiveChild}
            onOpenChildSession={setChildSessionTarget}
            {...(onStopChildRun !== undefined ? { onStopChildRun } : {})}
          />
        ) : null}

        <AssistantComposer
          draftRequest={composerDraftRequest}
          followupSuggestion={followupSuggestion}
          onDismissFollowupSuggestion={onDismissFollowupSuggestion}
          onOpenSkills={onOpenSkills}
          onOpenMcpSettings={onOpenMcpSettings}
          isBusy={isBusy}
          isRunning={canInterject}
          controls={{
            ...composerControls,
            // 모델 변경만 제공자 전환 훅을 거친다 — 문맥 한계에 걸리면
            // 압축 확인을 띄우고 통과하면 원래 컨트롤 핸들러로 내린다.
            onModelIdChange: requestModelChange,
          }}
          contextUsage={contextUsage}
          goalSnapshot={goal?.snapshot ?? null}
          workingDirectory={workspaceInput.workingDirectory}
          browseStartPath={workspaceInput.browseStartPath}
          workingDirectorySelectionPending={
            workingDirectoryPicker.selectionPending
          }
          {...(workingDirectoryPicker.canChange
            ? {
                onOpenWorkingDirectoryPicker: workingDirectoryPicker.openPicker,
              }
            : {})}
          {...(onUploadFiles !== undefined
            ? { onUploadFiles: uploadFiles }
            : {})}
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          uploadPending={uploadPending}
          onCancel={onCancel}
          onSend={handleSend}
          {...(imageProviderConnected !== undefined
            ? { imageProviderConnected }
            : {})}
        />
      </div>
      <ProviderTransitionDialog
        pending={pendingProviderTransition}
        recoveryRequired={providerTransitionRecoveryRequired}
        transitionPending={providerTransitionPending}
        error={providerTransitionError}
        onCancel={cancelProviderTransition}
        onConfirm={() => void confirmProviderTransition()}
      />
    </section>
  );
}
