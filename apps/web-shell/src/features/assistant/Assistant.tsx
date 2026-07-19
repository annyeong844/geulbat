import React, { useCallback, useMemo, useState } from 'react';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type {
  RunAttachmentInput,
  RunModelId,
  RunReasoningEffort,
  RunRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  resolveRunModelDescriptor,
} from '@geulbat/protocol/run-contract';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';
import { getErrorMessage } from '../../lib/error-message.js';

import type {
  ContextUsageUpdatedEventPayload,
  RunUsageTotals,
} from '@geulbat/protocol/run-events';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import {
  AssistantComposer,
  type AssistantComposerDraftRequest,
  type ComposerAttachment,
} from './AssistantComposer.js';
import { AssistantTranscript } from './AssistantTranscript.js';
import type { WidgetToolRequestHandler } from './visualize/visualize-widget.js';
import { assistantStyles } from './assistant-styles.js';
import { BackgroundWorkSheet } from './background-work-sheet.js';
import {
  ChildSessionViewer,
  type ChildSessionTarget,
} from './ChildSessionViewer.js';
import { PendingSteerList } from './PendingSteerList.js';
import { RunPlanCard } from './run-plan/run-plan-card.js';
import { resolveLatestRunPlan } from './run-plan/run-plan.js';

interface Props {
  messages: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  activeArtifact?: ThreadArtifactVersion | null;
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  streamError: string | null;
  isRunning: boolean;
  isStarting?: boolean;
  isSettling?: boolean;
  // 실행 중 상태줄에 표시할 런 누적 토큰 사용량
  usageTotals?: RunUsageTotals | null;
  contextUsage?: ContextUsageUpdatedEventPayload | null;
  onSend: (
    prompt: string,
    attachments?: RunAttachmentInput[],
  ) => Promise<void> | void;
  // 위젯/프레임 발 request_prompt — 전송 경로는 onSend와 같지만 턴을
  // 아티팩트 발로 귀속 렌더한다. 없으면 onSend로 폴백(무귀속).
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출(run.tool) — 컨트롤러가 신뢰 컨텍스트를 주입해 실행
  onWidgetToolRequest?: WidgetToolRequestHandler;
  // 답변 재생성(덮어쓰기) — 없으면 onSend 재전송(새 턴 추가)으로 동작
  onRegenerate?: (prompt: string) => Promise<void> | void;
  // ⑂ 여기서 새 채팅 — 해당 답변까지의 prefix를 복제한 새 스레드로 전환
  onBranchFromMessage?: (entryId: string) => Promise<void> | void;
  // 브랜치 성공 알림 — 전환이 화면상 티가 안 나므로 명시적으로 알린다
  branchNotice?: string | null;
  onDismissBranchNotice?: () => void;
  // 과거 질문 편집 — 직전까지 브랜치한 새 스레드에서 수정본으로 재실행
  onEditPastUserPrompt?: (
    entryId: string,
    nextPrompt: string,
  ) => Promise<void> | void;
  // 대기 중 스티어 큐 + 취소 — 있으면 입력창 위에 큐 행을 그린다
  pendingSteers?: Array<{ receivedSeq: number; text: string }>;
  onCancelSteer?: (receivedSeq: number) => Promise<void> | void;
  // 지금 반영 — 다음 라운드를 기다리지 않고 큐를 즉시 소비 지점으로
  onFlushSteers?: () => Promise<void> | void;
  pendingSteerFlushRequested?: boolean;
  onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
  // 존재하면 아티팩트는 채팅 인라인 대신 참조 칩 + 중앙 패널로 흐른다
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
  onCancel: () => Promise<void> | void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  modelId?: RunModelId;
  onModelIdChange?: (modelId: RunModelId) => void;
  onPrepareProviderTransition?: (targetModelId: RunModelId) => Promise<void>;
  reasoningEffort?: RunReasoningEffort;
  onReasoningEffortChange?: (effort: RunReasoningEffort) => void;
  subagentModelRouting?: RunSubagentModelRouting;
  onSubagentModelRoutingChange?: (routing: RunSubagentModelRouting) => void;
  workingDirectory?: string | null;
  browseStartPath?: string;
  onChooseWorkingDirectory?: () => Promise<void>;
  onUploadFiles?: (files: FileList) => Promise<ComposerAttachment[]>;
  onDiscardUploadedAttachment?: (contentRef: string) => void;
  attachmentImageUrl?: (attachmentId: string) => string | null;
  approvalPanel?: React.ReactNode;
  composerDraftRequest?: AssistantComposerDraftRequest | null;
  // [+] 메뉴 이미지 서브패널의 프로바이더 연결 상태
  imageProviderConnected?: {
    grok_oauth?: boolean;
    openai_codex_direct?: boolean;
  };
}

const EMPTY_ARTIFACTS: ThreadArtifactVersion[] = [];
const EMPTY_PENDING_STEERS: Array<{ receivedSeq: number; text: string }> = [];

export function Assistant({
  messages,
  artifacts = EMPTY_ARTIFACTS,
  activeArtifact = null,
  backgroundNotifications,
  transcriptEntries,
  finalAnswerText,
  streamError,
  isRunning,
  isStarting = false,
  isSettling = false,
  usageTotals = null,
  contextUsage = null,
  onSend,
  onWidgetPrompt,
  onWidgetToolRequest,
  onRegenerate,
  onBranchFromMessage,
  branchNotice = null,
  onDismissBranchNotice,
  onEditPastUserPrompt,
  pendingSteers = EMPTY_PENDING_STEERS,
  onCancelSteer,
  onFlushSteers,
  pendingSteerFlushRequested = false,
  onStartArtifactRun,
  onOpenArtifact,
  onCancel,
  permissionMode = 'basic',
  onPermissionModeChange = () => {},
  modelId = 'gpt-5.6-sol',
  onModelIdChange = () => {},
  onPrepareProviderTransition,
  reasoningEffort = 'medium',
  onReasoningEffortChange = () => {},
  subagentModelRouting = DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  onSubagentModelRoutingChange = () => {},
  workingDirectory = null,
  browseStartPath = '',
  onChooseWorkingDirectory,
  onUploadFiles,
  onDiscardUploadedAttachment,
  attachmentImageUrl,
  approvalPanel = null,
  composerDraftRequest = null,
  imageProviderConnected,
}: Props) {
  // 열려 있는 차일드 세션 드릴다운 대상 (없으면 닫힘)
  const [childSessionTarget, setChildSessionTarget] =
    useState<ChildSessionTarget | null>(null);
  // 다음 메시지에 실을 첨부 — 업로드된 ref를 들고 있다가 전송 시 소비
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadPending, setUploadPending] = useState(false);
  const [pendingProviderTransition, setPendingProviderTransition] = useState<{
    sourceModelId: RunModelId;
    targetModelId: RunModelId;
  } | null>(null);
  const [providerTransitionPending, setProviderTransitionPending] =
    useState(false);
  const [workingDirectorySelectionError, setWorkingDirectorySelectionError] =
    useState<string | null>(null);
  const [
    workingDirectorySelectionPending,
    setWorkingDirectorySelectionPending,
  ] = useState(false);
  const [providerTransitionError, setProviderTransitionError] = useState<
    string | null
  >(null);
  // 시작 중에는 아직 steer 대상 run이 확정되지 않았다. 실제 running일 때만
  // 실행 중 입력을 열어 run.interject로 보낸다.
  const isBusy = isStarting || isSettling;
  const canInterject = isRunning && !isStarting && !isSettling;
  const chooseWorkingDirectory = useCallback(async () => {
    if (
      onChooseWorkingDirectory === undefined ||
      workingDirectorySelectionPending
    ) {
      return;
    }
    setWorkingDirectorySelectionPending(true);
    setWorkingDirectorySelectionError(null);
    try {
      await onChooseWorkingDirectory();
    } catch (error: unknown) {
      setWorkingDirectorySelectionError(
        `시작 위치 창을 열지 못했습니다. ${getErrorMessage(error)}`,
      );
    } finally {
      setWorkingDirectorySelectionPending(false);
    }
  }, [onChooseWorkingDirectory, workingDirectorySelectionPending]);
  const requestModelChange = useCallback(
    (targetModelId: RunModelId) => {
      if (targetModelId === modelId || isRunning || isBusy) {
        return;
      }
      const source = resolveRunModelDescriptor(modelId);
      const target = resolveRunModelDescriptor(targetModelId);
      if (messages.length === 0 || source.providerId === target.providerId) {
        onModelIdChange(targetModelId);
        return;
      }
      setProviderTransitionError(null);
      setPendingProviderTransition({
        sourceModelId: modelId,
        targetModelId,
      });
    },
    [isBusy, isRunning, messages.length, modelId, onModelIdChange],
  );
  const cancelProviderTransition = useCallback(() => {
    if (providerTransitionPending) {
      return;
    }
    setPendingProviderTransition(null);
    setProviderTransitionError(null);
  }, [providerTransitionPending]);
  const confirmProviderTransition = useCallback(async () => {
    const transition = pendingProviderTransition;
    if (transition === null || providerTransitionPending) {
      return;
    }
    if (modelId !== transition.sourceModelId) {
      setProviderTransitionError(
        '모델 선택이 달라졌어요. 창을 닫고 다시 선택해 주세요.',
      );
      return;
    }
    if (onPrepareProviderTransition === undefined) {
      setProviderTransitionError(
        '이 대화에서는 제공자 전환 문맥을 준비할 수 없어요.',
      );
      return;
    }

    setProviderTransitionPending(true);
    setProviderTransitionError(null);
    try {
      await onPrepareProviderTransition(transition.targetModelId);
      onModelIdChange(transition.targetModelId);
      setPendingProviderTransition(null);
    } catch (error: unknown) {
      setProviderTransitionError(
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : '제공자 전환 문맥을 준비하지 못했어요.',
      );
    } finally {
      setProviderTransitionPending(false);
    }
  }, [
    modelId,
    onModelIdChange,
    onPrepareProviderTransition,
    pendingProviderTransition,
    providerTransitionPending,
  ]);

  // silent 사용자 턴(아티팩트 ♻ 등 UI 발 자동 요청)은 채팅에도, 재시도/편집
  // 대상에도 넣지 않는다.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !(message.role === 'user' && message.metadata?.silent === true),
      ),
    [messages],
  );

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
  const canRetryLastPrompt =
    !isRunning &&
    !isBusy &&
    lastUserPrompt !== undefined &&
    (lastMessage?.role === 'assistant' || streamError !== null);
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

  // 진행 상황 체크리스트 — 가장 최근 update_plan 호출이 현재 계획이다
  const runPlan = useMemo(
    () => resolveLatestRunPlan({ messages, transcriptEntries }),
    [messages, transcriptEntries],
  );

  // 백그라운드 작업 시트 — 트랜스크립트와 알림에 흩어진 서브에이전트
  // 활동을 childRunId 기준 최신 상태로 모은다
  const [backgroundSheetOpen, setBackgroundSheetOpen] = useState(false);
  const backgroundWorkEntries = useMemo(() => {
    const byChildRunId = new Map<
      string,
      Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>
    >();
    for (const entry of transcriptEntries) {
      if (entry.kind === 'subagent_activity') {
        byChildRunId.set(entry.childRunId, entry);
      }
    }
    for (const entry of backgroundNotifications) {
      byChildRunId.set(entry.childRunId, entry);
    }
    return [...byChildRunId.values()];
  }, [backgroundNotifications, transcriptEntries]);
  const backgroundRunningCount = backgroundWorkEntries.filter(
    (entry) => entry.state === 'spawned' || entry.state === 'approval_required',
  ).length;

  const uploadFiles = useCallback(
    async (files: FileList) => {
      if (onUploadFiles === undefined) {
        return;
      }
      setUploadPending(true);
      try {
        const uploaded = await onUploadFiles(files);
        setAttachments((prev) => [...prev, ...uploaded]);
      } finally {
        setUploadPending(false);
      }
    },
    [onUploadFiles],
  );

  const handleRemoveAttachment = useCallback(
    (contentRef: string) => {
      setAttachments((prev) => {
        const removed = prev.find(
          (attachment) => attachment.contentRef === contentRef,
        );
        if (removed?.previewUrl !== undefined) {
          URL.revokeObjectURL(removed.previewUrl);
        }
        return prev.filter(
          (attachment) => attachment.contentRef !== contentRef,
        );
      });
      onDiscardUploadedAttachment?.(contentRef);
    },
    [onDiscardUploadedAttachment],
  );

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
        setAttachments((prev) => {
          for (const attachment of prev) {
            if (attachment.previewUrl !== undefined) {
              URL.revokeObjectURL(attachment.previewUrl);
            }
          }
          return [];
        });
        return true;
      } catch {
        return false;
      }
    },
    [attachments, isBusy, onSend, uploadPending],
  );

  return (
    <section className="assistant" style={assistantStyles.section}>
      <AssistantTranscript
        messages={visibleMessages}
        artifacts={artifacts}
        backgroundNotifications={backgroundNotifications}
        transcriptEntries={transcriptEntries}
        finalAnswerText={finalAnswerText}
        activeArtifact={activeArtifact}
        streamError={streamError}
        isRunning={isRunning}
        usageTotals={usageTotals}
        onStartArtifactRun={onStartArtifactRun}
        {...(attachmentImageUrl !== undefined ? { attachmentImageUrl } : {})}
        {...(canRetryLastPrompt ? { onRetryLastPrompt: retryLastPrompt } : {})}
        {...(canEditLastUserPrompt
          ? { onEditLastUserPrompt: editLastUserPrompt }
          : {})}
        {...(canBranchFromMessage
          ? { onBranchFromMessage: branchFromMessage }
          : {})}
        {...(canEditPastUserPrompt
          ? { onEditPastUserPrompt: editPastUserPrompt }
          : {})}
        onOpenChildSession={setChildSessionTarget}
        // visualize 위젯의 sendPrompt — 컴포저와 같은 전송 경로로 합류시켜
        // 실행 중이면 스티어, 아니면 새 턴이 된다. 전용 경로가 배선되면
        // 턴이 아티팩트 발로 귀속 렌더된다.
        onWidgetPrompt={onWidgetPrompt ?? onSend}
        // ask_user 답변은 사용자 선택 — 아티팩트 귀속 없이 일반 전송
        onAskUserAnswer={onSend}
        {...(onWidgetToolRequest !== undefined ? { onWidgetToolRequest } : {})}
        {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
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

      {backgroundWorkEntries.length > 0 ? (
        <button
          type="button"
          className="background-work-chip"
          onClick={() => setBackgroundSheetOpen(true)}
        >
          <span
            className={`subagent-state-dot ${
              backgroundRunningCount > 0 ? 'spawned' : 'completed'
            }`}
            aria-hidden="true"
          />
          <span>
            백그라운드 작업 {backgroundWorkEntries.length}
            {backgroundRunningCount > 0
              ? ` · 실행 중 ${backgroundRunningCount}`
              : ''}
          </span>
          <span aria-hidden="true">›</span>
        </button>
      ) : null}

      {backgroundSheetOpen ? (
        <BackgroundWorkSheet
          entries={backgroundWorkEntries}
          onClose={() => setBackgroundSheetOpen(false)}
          onOpenChildSession={(entry) => {
            setBackgroundSheetOpen(false);
            setChildSessionTarget(entry);
          }}
        />
      ) : null}

      {runPlan !== null ? (
        <RunPlanCard plan={runPlan} isRunning={isRunning} />
      ) : null}

      {approvalPanel}

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

      {workingDirectorySelectionError !== null ? (
        <p className="working-directory-selection-error" role="alert">
          {workingDirectorySelectionError}
        </p>
      ) : null}

      <AssistantComposer
        draftRequest={composerDraftRequest}
        isBusy={isBusy}
        isRunning={canInterject}
        permissionMode={permissionMode}
        modelId={modelId}
        contextUsage={contextUsage}
        reasoningEffort={reasoningEffort}
        subagentModelRouting={subagentModelRouting}
        onPermissionModeChange={onPermissionModeChange}
        onModelIdChange={requestModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onSubagentModelRoutingChange={onSubagentModelRoutingChange}
        workingDirectory={workingDirectory}
        browseStartPath={browseStartPath}
        workingDirectorySelectionPending={workingDirectorySelectionPending}
        {...(onChooseWorkingDirectory !== undefined
          ? {
              onOpenWorkingDirectoryPicker: () => {
                void chooseWorkingDirectory();
              },
            }
          : {})}
        {...(onUploadFiles !== undefined ? { onUploadFiles: uploadFiles } : {})}
        attachments={attachments}
        onRemoveAttachment={handleRemoveAttachment}
        uploadPending={uploadPending}
        onCancel={onCancel}
        onSend={handleSend}
        {...(imageProviderConnected !== undefined
          ? { imageProviderConnected }
          : {})}
      />
      {pendingProviderTransition !== null ? (
        <>
          <button
            type="button"
            aria-label="모델 제공자 전환 취소"
            className="video-settings-backdrop"
            disabled={providerTransitionPending}
            onClick={cancelProviderTransition}
          />
          <section
            className="video-settings-card provider-transition-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="provider-transition-title"
            aria-describedby="provider-transition-description"
          >
            <div className="video-settings-header">
              <h2
                id="provider-transition-title"
                className="video-settings-title"
              >
                모델 제공자를 변경할까요?
              </h2>
            </div>
            <p
              id="provider-transition-description"
              className="provider-transition-description"
            >
              {
                resolveRunModelDescriptor(
                  pendingProviderTransition.sourceModelId,
                ).label
              }
              에서{' '}
              {
                resolveRunModelDescriptor(
                  pendingProviderTransition.targetModelId,
                ).label
              }
              로 전환하려면 현재 대화 문맥을 다른 제공자가 읽을 수 있는 요약으로
              압축해야 합니다. 원본 대화 기록은 삭제하지 않지만, 전환 뒤 모델은
              압축된 문맥에서 계속합니다.
            </p>
            {providerTransitionError !== null ? (
              <p className="provider-transition-error" role="alert">
                {providerTransitionError}
              </p>
            ) : null}
            <div className="provider-transition-actions">
              <button
                type="button"
                className="provider-transition-cancel"
                disabled={providerTransitionPending}
                onClick={cancelProviderTransition}
              >
                전환 취소
              </button>
              <button
                type="button"
                className="video-settings-save"
                disabled={providerTransitionPending}
                onClick={() => void confirmProviderTransition()}
              >
                {providerTransitionPending
                  ? '전환 문맥 준비 중…'
                  : '문맥 압축 후 전환'}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
