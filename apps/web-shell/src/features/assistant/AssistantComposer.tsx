import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import type {
  PlanModeDepth,
  PlanModeIntensity,
} from '@geulbat/protocol/planning-workflow';
import {
  IMAGE_GENERATION_MODEL_CATALOG,
  VIDEO_GENERATION_MODEL_CATALOG,
  resolveImageGenerationModelDescriptor,
  type RunModelId,
  type RunReasoningSelection,
  type RunServiceTier,
  type RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

import { IMAGE_GENERATION_MODEL_TAGLINES } from './model-copy.js';
import {
  getToolDiffExpandedDefault,
  getToolDiffExpandedDefaultServerSnapshot,
  setToolDiffExpandedDefault,
  subscribeToolDiffExpandedDefault,
} from './tool-diff-prefs.js';
import {
  getImageGenerationModelPref,
  getImageGenerationModelPrefServerSnapshot,
  setImageGenerationModelPref,
  subscribeImageGenerationModelPref,
  VERIFIED_IMAGE_GENERATION_MODEL_IDS,
} from './image-model-prefs.js';
import {
  getVideoGenerationPref,
  getVideoGenerationPrefServerSnapshot,
  subscribeVideoGenerationPref,
  VERIFIED_VIDEO_GENERATION_MODEL_IDS,
} from './video-generation-prefs.js';
import { VideoSettingsDialog } from './VideoSettingsDialog.js';
import {
  ComposerMenuButton,
  MenuBackRow,
  MenuNavRow,
  MenuOptionRow,
} from './composer-menu-rows.js';
import { ContextUsageRing } from './context-usage-ring.js';
import { AssistantComposerApprovalMenu } from './assistant-composer-approval-menu.js';
import { AssistantComposerModelMenu } from './assistant-composer-model-menu.js';
import { readGoalStartCommand } from './goal-command.js';

// 어시스턴트에게 보낼 첨부 — 업로드된 binary-input ref를 가리키고,
// 전송 시 run 요청에 실려 모델 입력(이미지/파일 본문)으로 전달된다
export interface ComposerAttachment {
  name: string;
  contentRef: string;
  mimeType?: string;
  // 이미지 첨부의 로컬 미리보기(object URL) — 소유권은 Assistant가 갖고
  // 제거/전송 시 revoke한다
  previewUrl?: string;
}

export interface AssistantComposerDraftRequest {
  requestId: number;
  text: string;
}

// 컴포저 상단 컨트롤 한 벌. 값과 변경 핸들러를 함께 소유하며,
// composition root가 이미 만든 projection을 다시 flat props로 풀지 않는다.
export interface AssistantComposerControls {
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void> | void;
  planModeRequested: boolean;
  onPlanModeRequestedChange: (planModeRequested: boolean) => void;
  planModeIntensity: PlanModeIntensity;
  onPlanModeIntensityChange: (intensity: PlanModeIntensity) => void;
  planModeDepth: PlanModeDepth;
  onPlanModeDepthChange: (depth: PlanModeDepth) => void;
  modelId: RunModelId;
  onModelIdChange: (modelId: RunModelId) => void;
  reasoningEffort: RunReasoningSelection;
  onReasoningEffortChange: (effort: RunReasoningSelection) => void;
  serviceTier: RunServiceTier;
  onServiceTierChange: (serviceTier: RunServiceTier) => void;
  subagentModelRouting: RunSubagentModelRouting;
  onSubagentModelRoutingChange: (routing: RunSubagentModelRouting) => void;
}

interface AssistantComposerProps {
  isBusy: boolean;
  isRunning: boolean;
  controls: AssistantComposerControls;
  contextUsage?: ContextUsageUpdatedEventPayload | null;
  workingDirectory?: string | null;
  browseStartPath?: string;
  workingDirectorySelectionPending?: boolean;
  onOpenWorkingDirectoryPicker?: () => void;
  onUploadFiles?: ((files: FileList) => Promise<void>) | undefined;
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (contentRef: string) => void;
  uploadPending?: boolean;
  onCancel: () => Promise<void> | void;
  onSend: (input: string) => Promise<boolean>;
  draftRequest?: AssistantComposerDraftRequest | null;
  /**
   * 다음 걸음 제안. 비어 있으면 아무것도 안 뜬다 — 명확할 때만 온다.
   * 사용자가 직접 입력하면 사라진다(입력값이 있으면 자리표시가 가려진다).
   */
  followupSuggestion?: string | null | undefined;
  onDismissFollowupSuggestion?: (() => void) | undefined;
  // 이미지 모델 서브패널의 프로바이더 연결 상태 — 미연결 프로바이더의
  // 모델 행은 비활성으로 그린다(§3)
  imageProviderConnected?: {
    grok_oauth?: boolean;
    openai_codex_direct?: boolean;
  };
}

type OpenMenu = 'plus' | 'permission' | 'model' | null;

export function AssistantComposer({
  isBusy,
  isRunning,
  controls: {
    permissionMode,
    onPermissionModeChange,
    planModeRequested,
    onPlanModeRequestedChange,
    planModeIntensity,
    onPlanModeIntensityChange,
    planModeDepth,
    onPlanModeDepthChange,
    modelId,
    onModelIdChange,
    reasoningEffort,
    onReasoningEffortChange,
    serviceTier,
    onServiceTierChange,
    subagentModelRouting,
    onSubagentModelRoutingChange,
  },
  contextUsage = null,
  workingDirectory = null,
  browseStartPath = '',
  workingDirectorySelectionPending = false,
  onOpenWorkingDirectoryPicker,
  onUploadFiles,
  attachments = [],
  onRemoveAttachment,
  uploadPending = false,
  onCancel,
  onSend,
  draftRequest = null,
  followupSuggestion = null,
  onDismissFollowupSuggestion,
  imageProviderConnected = {},
}: AssistantComposerProps) {
  const [input, setInput] = useState('');
  const goalStartCommand = readGoalStartCommand(input);
  // 제안은 빈 입력에서만 보인다 — 사용자가 뭐라도 쓰기 시작하면 물러난다.
  const activeSuggestion =
    followupSuggestion !== null && followupSuggestion !== '' && input === ''
      ? followupSuggestion
      : null;
  const acceptFollowupSuggestion = useCallback(() => {
    if (activeSuggestion === null) {
      return;
    }
    setInput(activeSuggestion);
    onDismissFollowupSuggestion?.();
  }, [activeSuggestion, onDismissFollowupSuggestion]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  // [+] 메뉴 내부 페이지 — '이미지 ›' 서브패널(스펙 v3 §3)
  const [plusMenuPage, setPlusMenuPage] = useState<'root' | 'image'>('root');
  useEffect(() => {
    if (draftRequest === null) {
      return;
    }
    const mention = draftRequest.text.trim();
    if (mention === '') {
      return;
    }
    setInput((current) => {
      if (current.includes(mention)) {
        return current;
      }
      return current.trim() === '' ? `${mention} ` : `${mention} ${current}`;
    });
    inputRef.current?.focus();
  }, [draftRequest]);
  // 기본 이미지 모델 설정 — 선택 즉시 메뉴 행 현재값과 run 요청에 반영
  const imageModelPref = useSyncExternalStore(
    subscribeImageGenerationModelPref,
    getImageGenerationModelPref,
    getImageGenerationModelPrefServerSnapshot,
  );
  const imageModelLabel =
    imageModelPref === null
      ? '시스템 기본값'
      : resolveImageGenerationModelDescriptor(imageModelPref).label;
  // 동영상 설정(스펙 §3/D-V3) — 행 클릭 시 전용 설정 팝업에서 조작
  const videoPref = useSyncExternalStore(
    subscribeVideoGenerationPref,
    getVideoGenerationPref,
    getVideoGenerationPrefServerSnapshot,
  );
  const videoModel = VIDEO_GENERATION_MODEL_CATALOG[0];
  const videoModelVerified = VERIFIED_VIDEO_GENERATION_MODEL_IDS.has(
    videoModel.id,
  );
  const videoLabel =
    videoPref === null
      ? '시스템 기본값'
      : [
          videoModel.label,
          `${videoPref.durationSeconds ?? 5}초`,
          ...(videoPref.aspectRatio !== undefined
            ? [videoPref.aspectRatio]
            : []),
          ...(videoPref.resolution !== undefined ? [videoPref.resolution] : []),
        ].join(' · ');
  const [videoSettingsOpen, setVideoSettingsOpen] = useState(false);
  const openVideoSettings = () => setVideoSettingsOpen(true);
  const [imageModelNotice, setImageModelNotice] = useState<string | null>(null);
  const showImageModelNotice = (notice: string) => {
    setImageModelNotice(notice);
  };
  // diff 기본 펼침 설정 — [+] 메뉴에서 온오프, 대화창 diff 블록이 구독한다
  const toolDiffExpanded = useSyncExternalStore(
    subscribeToolDiffExpandedDefault,
    getToolDiffExpandedDefault,
    getToolDiffExpandedDefaultServerSnapshot,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // 브라우저에서만 바깥 클릭 닫기 — node 테스트 러너에는 window가 없다
    if (openMenu === null || typeof window === 'undefined') {
      return;
    }
    const close = (event: MouseEvent) => {
      if (
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.matches('.composer-menu-anchor'),
          )
      ) {
        return;
      }
      setOpenMenu(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [openMenu]);

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => {
    setImageModelNotice(null);
    setPlusMenuPage('root');
    setOpenMenu((prev) => (prev === menu ? null : menu));
  };

  const closeMenu = () => {
    setOpenMenu(null);
    setPlusMenuPage('root');
  };

  const handleSend = async () => {
    const submittedInput = input;
    if (await onSend(submittedInput)) {
      setImageModelNotice(null);
      setInput((current) => (current === submittedInput ? '' : current));
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isRunning) {
      event.preventDefault();
      void onCancel();
      return;
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void handleSend();
    }
  };

  const sendDisabled =
    isBusy || uploadPending || (!input.trim() && attachments.length === 0);
  const selectedWorkingDirectory = workingDirectory ?? browseStartPath;
  const workingDirectoryLabel =
    selectedWorkingDirectory === '' ? '컴퓨터 루트' : selectedWorkingDirectory;
  const workingDirectorySelectionDisabled =
    onOpenWorkingDirectoryPicker === undefined ||
    isBusy ||
    isRunning ||
    workingDirectorySelectionPending;

  const handleUpload = (files: FileList | null) => {
    closeMenu();
    if (files && files.length > 0 && onUploadFiles) {
      void onUploadFiles(files);
    }
  };

  const openFileInputPicker = (input: HTMLInputElement | null) => {
    closeMenu();
    if (input === null) {
      return;
    }
    input.value = '';
    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker();
        return;
      } catch {
        // Older embedded browsers can expose showPicker without allowing it.
      }
    }
    input.click();
  };

  return (
    <div className="composer">
      {imageModelNotice !== null ? (
        <div className="branch-notice" role="status">
          <span className="branch-notice-text">{imageModelNotice}</span>
          <button
            type="button"
            className="branch-notice-dismiss"
            aria-label="모델 설정 알림 닫기"
            onClick={() => setImageModelNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
      {videoSettingsOpen ? (
        <VideoSettingsDialog
          videoModel={videoModel}
          videoModelVerified={videoModelVerified}
          videoModelConnected={
            imageProviderConnected[videoModel.providerId] === true
          }
          videoPref={videoPref}
          onClose={() => setVideoSettingsOpen(false)}
          onNotice={showImageModelNotice}
        />
      ) : null}
      {attachments.length > 0 || uploadPending ? (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span
              key={attachment.contentRef}
              className="attachment-chip"
              title={`${attachment.name} — 보내면 어시스턴트가 내용을 봅니다`}
            >
              {attachment.previewUrl !== undefined ? (
                <img
                  className="attachment-chip-thumb"
                  src={attachment.previewUrl}
                  alt={attachment.name}
                />
              ) : (
                '📎'
              )}{' '}
              {attachment.name}
              {onRemoveAttachment ? (
                <button
                  type="button"
                  className="attachment-chip-remove"
                  aria-label={`${attachment.name} 첨부 제거`}
                  onClick={() => onRemoveAttachment(attachment.contentRef)}
                >
                  ✕
                </button>
              ) : null}
            </span>
          ))}
          {uploadPending ? (
            <span className="attachment-chip pending">업로드 중…</span>
          ) : null}
        </div>
      ) : null}
      {/* 입력과 컨트롤이 한 카드 — 질문 창이 아래 컨트롤 줄까지 이어진다 */}
      <div className="input-shell">
        {goalStartCommand !== null ? (
          <span
            className="composer-goal-command-indicator"
            role="status"
            aria-label="목표 명령을 인식했어요. 목표로 실행합니다."
          >
            <span className="composer-goal-command-token">/goal</span>
            <span className="composer-goal-command-label">목표로 실행</span>
          </span>
        ) : null}
        <textarea
          ref={inputRef}
          name="assistant-message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isRunning
              ? '실행 중 — 지시를 추가하면 바로 반영돼요…'
              : (activeSuggestion ?? '어시스턴트에게 물어보거나 부탁하기…')
          }
          disabled={isBusy}
          rows={2}
        />
        {activeSuggestion !== null && !isBusy ? (
          <button
            type="button"
            className="composer-followup-accept"
            onClick={acceptFollowupSuggestion}
            title={`다음 작업으로 입력: ${activeSuggestion}`}
            aria-label={`다음 작업으로 입력: ${activeSuggestion}`}
          >
            →
          </button>
        ) : null}

        <div className="composer-footer">
          <span className="composer-footer-group">
            <ComposerMenuButton
              label="+"
              title="첨부와 도구"
              active={openMenu === 'plus'}
              onToggle={() => toggleMenu('plus')}
            >
              {openMenu === 'plus' ? (
                <div className="composer-menu" role="menu">
                  {plusMenuPage === 'root' ? (
                    <>
                      <MenuOptionRow
                        title="파일 업로드"
                        description="어시스턴트에게 첨부"
                        disabled={!onUploadFiles || isRunning}
                        onClick={() =>
                          openFileInputPicker(fileInputRef.current)
                        }
                      />
                      <MenuOptionRow
                        title="이미지 업로드"
                        description="어시스턴트에게 첨부"
                        disabled={!onUploadFiles || isRunning}
                        onClick={() =>
                          openFileInputPicker(imageInputRef.current)
                        }
                      />
                      <div className="context-menu-divider" />
                      <MenuOptionRow
                        title="시작 위치"
                        description={
                          workingDirectorySelectionPending
                            ? '폴더 선택 창이 열려 있어요'
                            : workingDirectoryLabel
                        }
                        disabled={workingDirectorySelectionDisabled}
                        onClick={() => {
                          closeMenu();
                          onOpenWorkingDirectoryPicker?.();
                        }}
                      />
                      <MenuNavRow
                        label="이미지"
                        value={imageModelLabel}
                        onClick={() => setPlusMenuPage('image')}
                      />
                      <MenuNavRow
                        label="동영상"
                        value={videoLabel}
                        onClick={() => {
                          closeMenu();
                          openVideoSettings();
                        }}
                      />
                      <MenuOptionRow
                        title="카메라"
                        description="추후 지원"
                        disabled
                      />
                      <div className="context-menu-divider" />
                      <MenuOptionRow
                        title="diff 항상 펼치기"
                        description="파일 변경 내용을 펼친 채로 표시"
                        checked={toolDiffExpanded}
                        onClick={() => {
                          setToolDiffExpandedDefault(!toolDiffExpanded);
                        }}
                      />
                    </>
                  ) : null}

                  {plusMenuPage === 'image' ? (
                    <>
                      <MenuBackRow
                        label="기본 이미지 모델"
                        onClick={() => setPlusMenuPage('root')}
                      />
                      <div className="composer-menu-note">
                        대화에서 &ldquo;…그려줘&rdquo;라고 요청하면 이 모델로
                        생성돼요.
                      </div>
                      {IMAGE_GENERATION_MODEL_CATALOG.map((model) => {
                        const connected =
                          imageProviderConnected[model.providerId] === true;
                        const verified =
                          VERIFIED_IMAGE_GENERATION_MODEL_IDS.has(model.id);
                        return (
                          <MenuOptionRow
                            key={model.id}
                            title={model.label}
                            description={
                              !verified
                                ? '검증 대기'
                                : !connected
                                  ? 'AI 제공자 연결 필요'
                                  : IMAGE_GENERATION_MODEL_TAGLINES[model.id]
                            }
                            checked={imageModelPref === model.id}
                            disabled={!verified || !connected}
                            onClick={() => {
                              setImageGenerationModelPref(model.id);
                              showImageModelNotice(
                                `기본 이미지 모델을 ${model.label}(으)로 설정했어요`,
                              );
                              closeMenu();
                            }}
                          />
                        );
                      })}
                      <MenuOptionRow
                        title="시스템 기본값"
                        description="선택 해제 — 데몬 기본 설정을 따릅니다"
                        checked={imageModelPref === null}
                        onClick={() => {
                          setImageGenerationModelPref(null);
                          showImageModelNotice(
                            '기본 이미지 모델 선택을 해제했어요',
                          );
                          closeMenu();
                        }}
                      />
                    </>
                  ) : null}
                </div>
              ) : null}
            </ComposerMenuButton>
            <AssistantComposerApprovalMenu
              active={openMenu === 'permission'}
              permissionMode={permissionMode}
              planModeRequested={planModeRequested}
              planModeIntensity={planModeIntensity}
              planModeDepth={planModeDepth}
              onToggle={() => toggleMenu('permission')}
              onClose={closeMenu}
              onPermissionModeChange={onPermissionModeChange}
              onPlanModeRequestedChange={onPlanModeRequestedChange}
              onPlanModeIntensityChange={onPlanModeIntensityChange}
              onPlanModeDepthChange={onPlanModeDepthChange}
            />
          </span>

          <span className="composer-footer-group">
            <ContextUsageRing contextUsage={contextUsage} modelId={modelId} />
            <AssistantComposerModelMenu
              active={openMenu === 'model'}
              isBusy={isBusy}
              isRunning={isRunning}
              modelId={modelId}
              reasoningEffort={reasoningEffort}
              serviceTier={serviceTier}
              subagentModelRouting={subagentModelRouting}
              onToggle={() => toggleMenu('model')}
              onClose={closeMenu}
              onModelIdChange={onModelIdChange}
              onReasoningEffortChange={onReasoningEffortChange}
              onServiceTierChange={onServiceTierChange}
              onSubagentModelRoutingChange={onSubagentModelRoutingChange}
            />
            {isRunning ? (
              <button
                type="button"
                className="input-cancel"
                onClick={() => void onCancel()}
              >
                중단
              </button>
            ) : null}
            <button
              type="button"
              className="input-send"
              aria-label="보내기"
              title="보내기"
              onClick={() => void handleSend()}
              disabled={sendDisabled}
            >
              ➤
            </button>
          </span>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        name="computer-file-upload"
        aria-label="파일 업로드"
        title="파일 업로드"
        multiple
        hidden
        onChange={(event) => handleUpload(event.target.files)}
      />
      <input
        ref={imageInputRef}
        type="file"
        name="computer-image-upload"
        aria-label="이미지 업로드"
        title="이미지 업로드"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => handleUpload(event.target.files)}
      />
    </div>
  );
}
