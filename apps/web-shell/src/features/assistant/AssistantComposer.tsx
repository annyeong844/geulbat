import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  IMAGE_GENERATION_MODEL_CATALOG,
  RUN_MODEL_CATALOG,
  RUN_REASONING_EFFORTS,
  VIDEO_GENERATION_ASPECT_RATIOS,
  VIDEO_GENERATION_MODEL_CATALOG,
  VIDEO_GENERATION_RESOLUTIONS,
  type VideoGenerationAspectRatio,
  type VideoGenerationResolution,
  resolveImageGenerationModelDescriptor,
  resolveRunModelDescriptor,
  type RunModelId,
  type RunReasoningEffort,
  type RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

import {
  IMAGE_GENERATION_MODEL_TAGLINES,
  REASONING_EFFORT_LABELS,
  RUN_MODEL_TAGLINES,
} from './model-copy.js';
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
  setVideoGenerationPref,
  subscribeVideoGenerationPref,
  VERIFIED_VIDEO_GENERATION_MODEL_IDS,
} from './video-generation-prefs.js';

const PERMISSION_MODE_OPTIONS: Array<{
  value: PermissionMode;
  label: string;
  pillLabel: string;
  description: string;
  warning: boolean;
}> = [
  {
    value: 'basic',
    label: '수동 승인',
    pillLabel: '수동 승인',
    description: '위험한 작업마다 일시 중지하고 승인을 요청합니다.',
    warning: false,
  },
  {
    value: 'full_access',
    label: '모든 승인 건너뛰기',
    pillLabel: '승인 건너뛰기',
    description: '안전하지 않은 작업이라도 일시 중지하지 않습니다.',
    warning: true,
  },
];

const REASONING_EFFORT_NOTE =
  '더 높은 사고는 더 철저한 응답을 주지만, 시간이 더 오래 걸립니다.';

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

interface AssistantComposerProps {
  isBusy: boolean;
  isRunning: boolean;
  permissionMode: PermissionMode;
  modelId: RunModelId;
  contextUsage?: ContextUsageUpdatedEventPayload | null;
  reasoningEffort: RunReasoningEffort;
  subagentModelRouting: RunSubagentModelRouting;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onModelIdChange: (modelId: RunModelId) => void;
  onReasoningEffortChange: (effort: RunReasoningEffort) => void;
  onSubagentModelRoutingChange: (routing: RunSubagentModelRouting) => void;
  onUploadFiles?: ((files: FileList) => Promise<void>) | undefined;
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (contentRef: string) => void;
  uploadPending?: boolean;
  onCancel: () => Promise<void> | void;
  onSend: (input: string) => Promise<boolean>;
  draftRequest?: AssistantComposerDraftRequest | null;
  // 이미지 모델 서브패널의 프로바이더 연결 상태 — 미연결 프로바이더의
  // 모델 행은 비활성으로 그린다(§3)
  imageProviderConnected?: {
    grok_oauth?: boolean;
    openai_codex_direct?: boolean;
  };
}

type OpenMenu = 'plus' | 'permission' | 'model' | null;

// 모델 피커 내부 페이지 — 클로드식 2단 패널을 한 팝업 안에서 전환한다
type ModelMenuPage = 'root' | 'effort' | 'subagent' | 'subagent-effort';

export function AssistantComposer({
  isBusy,
  isRunning,
  permissionMode,
  modelId,
  contextUsage = null,
  reasoningEffort,
  subagentModelRouting = DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  onPermissionModeChange,
  onModelIdChange,
  onReasoningEffortChange,
  onSubagentModelRoutingChange,
  onUploadFiles,
  attachments = [],
  onRemoveAttachment,
  uploadPending = false,
  onCancel,
  onSend,
  draftRequest = null,
  imageProviderConnected = {},
}: AssistantComposerProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [modelMenuPage, setModelMenuPage] = useState<ModelMenuPage>('root');
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
  const [videoDraftEnabled, setVideoDraftEnabled] = useState(false);
  const [videoDraftDuration, setVideoDraftDuration] = useState(5);
  // '자동' = 미지정(프로바이더 기본) — null로 표현한다
  const [videoDraftAspectRatio, setVideoDraftAspectRatio] =
    useState<VideoGenerationAspectRatio | null>(null);
  const [videoDraftResolution, setVideoDraftResolution] =
    useState<VideoGenerationResolution | null>(null);
  const openVideoSettings = () => {
    setVideoDraftEnabled(videoPref !== null);
    setVideoDraftDuration(videoPref?.durationSeconds ?? 5);
    setVideoDraftAspectRatio(videoPref?.aspectRatio ?? null);
    setVideoDraftResolution(videoPref?.resolution ?? null);
    setVideoSettingsOpen(true);
  };
  const [imageModelNotice, setImageModelNotice] = useState<string | null>(null);
  const imageModelNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (imageModelNoticeTimerRef.current !== null) {
        clearTimeout(imageModelNoticeTimerRef.current);
      }
    },
    [],
  );
  const showImageModelNotice = (notice: string) => {
    setImageModelNotice(notice);
    if (imageModelNoticeTimerRef.current !== null) {
      clearTimeout(imageModelNoticeTimerRef.current);
    }
    imageModelNoticeTimerRef.current = setTimeout(() => {
      imageModelNoticeTimerRef.current = null;
      setImageModelNotice(null);
    }, 6000);
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
        event.target instanceof Element &&
        event.target.closest('.composer-menu-anchor') !== null
      ) {
        return;
      }
      setOpenMenu(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [openMenu]);

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => {
    setModelMenuPage('root');
    setPlusMenuPage('root');
    setOpenMenu((prev) => (prev === menu ? null : menu));
  };

  const closeMenu = () => {
    setOpenMenu(null);
    setModelMenuPage('root');
    setPlusMenuPage('root');
  };

  const handleSend = async () => {
    const submittedInput = input;
    if (await onSend(submittedInput)) {
      setInput((current) => (current === submittedInput ? '' : current));
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const sendDisabled =
    isBusy || uploadPending || (!input.trim() && attachments.length === 0);
  const permissionOption =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode) ??
    PERMISSION_MODE_OPTIONS[0]!;
  const model = resolveRunModelDescriptor(modelId);
  const effortLabel = REASONING_EFFORT_LABELS[reasoningEffort];
  const fixedSubagentModel =
    subagentModelRouting.mode === 'fixed'
      ? resolveRunModelDescriptor(subagentModelRouting.choice.modelId)
      : null;
  const fixedSubagentEffort =
    subagentModelRouting.mode === 'fixed'
      ? subagentModelRouting.choice.reasoningEffort
      : undefined;
  const subagentValueLabel =
    fixedSubagentModel === null
      ? '자동'
      : `${fixedSubagentModel.label}${
          fixedSubagentEffort === undefined
            ? ''
            : ` ${REASONING_EFFORT_LABELS[fixedSubagentEffort]}`
        } 고정`;

  const handleUpload = (files: FileList | null) => {
    closeMenu();
    if (files && files.length > 0 && onUploadFiles) {
      void onUploadFiles(files);
    }
  };

  return (
    <div className="composer">
      {imageModelNotice !== null ? (
        <div className="branch-notice" role="status">
          <span className="branch-notice-text">{imageModelNotice}</span>
        </div>
      ) : null}
      {videoSettingsOpen ? (
        <>
          <button
            type="button"
            aria-label="동영상 설정 닫기"
            className="video-settings-backdrop"
            onClick={() => setVideoSettingsOpen(false)}
          />
          <div
            className="video-settings-card"
            role="dialog"
            aria-label="동영상 설정"
          >
            <div className="video-settings-header">
              <span className="video-settings-title">동영상 설정</span>
              <button
                type="button"
                className="video-settings-close"
                onClick={() => setVideoSettingsOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="composer-menu-note">
              대화에서 &ldquo;…동영상 만들어줘&rdquo;라고 요청하면 이 설정으로
              생성돼요. 이미지를 먼저 그렸다면 &ldquo;움직여줘&rdquo;로
              애니메이션할 수 있어요.
            </div>
            <MenuOptionRow
              title={videoModel.label}
              description={
                !videoModelVerified
                  ? '검증 대기'
                  : imageProviderConnected[videoModel.providerId] !== true
                    ? 'AI 제공자 연결 필요'
                    : 'xAI · 글·이미지 모두 이 모델로'
              }
              checked={videoDraftEnabled}
              disabled={
                !videoModelVerified ||
                imageProviderConnected[videoModel.providerId] !== true
              }
              onClick={() => setVideoDraftEnabled(true)}
            />
            <MenuOptionRow
              title="시스템 기본값"
              description="선택 해제 — 데몬 기본 설정을 따릅니다"
              checked={!videoDraftEnabled}
              onClick={() => setVideoDraftEnabled(false)}
            />
            <div
              className={`video-settings-detail${videoDraftEnabled ? '' : ' disabled'}`}
            >
              <span className="video-settings-detail-label">
                길이 <strong>{videoDraftDuration}초</strong>
              </span>
              <input
                type="range"
                min={1}
                max={15}
                step={1}
                value={videoDraftDuration}
                disabled={!videoDraftEnabled}
                aria-label="동영상 길이(초)"
                onChange={(event) =>
                  setVideoDraftDuration(Number(event.target.value))
                }
              />
              <span className="video-settings-detail-hint">
                길수록 생성이 오래 걸려요 (1~15초)
              </span>
            </div>
            <div
              className={`video-settings-detail${videoDraftEnabled ? '' : ' disabled'}`}
            >
              <span className="video-settings-detail-label">
                화면비 <strong>{videoDraftAspectRatio ?? '자동'}</strong>
              </span>
              <div
                className="video-settings-chips"
                role="radiogroup"
                aria-label="화면비"
              >
                <button
                  type="button"
                  className={`video-settings-chip${videoDraftAspectRatio === null ? ' active' : ''}`}
                  disabled={!videoDraftEnabled}
                  onClick={() => setVideoDraftAspectRatio(null)}
                >
                  자동
                </button>
                {VIDEO_GENERATION_ASPECT_RATIOS.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    className={`video-settings-chip${videoDraftAspectRatio === ratio ? ' active' : ''}`}
                    disabled={!videoDraftEnabled}
                    onClick={() => setVideoDraftAspectRatio(ratio)}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>
            <div
              className={`video-settings-detail${videoDraftEnabled ? '' : ' disabled'}`}
            >
              <span className="video-settings-detail-label">
                해상도 <strong>{videoDraftResolution ?? '자동'}</strong>
              </span>
              <div
                className="video-settings-chips"
                role="radiogroup"
                aria-label="해상도"
              >
                <button
                  type="button"
                  className={`video-settings-chip${videoDraftResolution === null ? ' active' : ''}`}
                  disabled={!videoDraftEnabled}
                  onClick={() => setVideoDraftResolution(null)}
                >
                  자동
                </button>
                {VIDEO_GENERATION_RESOLUTIONS.map((resolution) => (
                  <button
                    key={resolution}
                    type="button"
                    className={`video-settings-chip${videoDraftResolution === resolution ? ' active' : ''}`}
                    disabled={!videoDraftEnabled}
                    onClick={() => setVideoDraftResolution(resolution)}
                  >
                    {resolution}
                  </button>
                ))}
              </div>
              <span className="video-settings-detail-hint">
                자동이면 모델이 알아서 정해요. 해상도가 높을수록 오래 걸려요.
              </span>
            </div>
            <div className="video-settings-actions">
              <button
                type="button"
                className="video-settings-save"
                onClick={() => {
                  if (videoDraftEnabled) {
                    setVideoGenerationPref({
                      model: videoModel.id,
                      durationSeconds: videoDraftDuration,
                      ...(videoDraftAspectRatio !== null
                        ? { aspectRatio: videoDraftAspectRatio }
                        : {}),
                      ...(videoDraftResolution !== null
                        ? { resolution: videoDraftResolution }
                        : {}),
                    });
                    showImageModelNotice(
                      `동영상 설정을 저장했어요 — ${videoModel.label} · ${videoDraftDuration}초${videoDraftAspectRatio !== null ? ` · ${videoDraftAspectRatio}` : ''}${videoDraftResolution !== null ? ` · ${videoDraftResolution}` : ''}`,
                    );
                  } else {
                    setVideoGenerationPref(null);
                    showImageModelNotice('동영상 설정을 해제했어요');
                  }
                  setVideoSettingsOpen(false);
                }}
              >
                저장
              </button>
            </div>
          </div>
        </>
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
      <div className="input-shell">
        <textarea
          ref={inputRef}
          name="assistant-message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isRunning
              ? '실행 중 — 지시를 추가하면 바로 반영돼요…'
              : '어시스턴트에게 물어보거나 부탁하기…'
          }
          disabled={isBusy}
          rows={2}
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
      </div>

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
                      onClick={() => fileInputRef.current?.click()}
                    />
                    <MenuOptionRow
                      title="이미지 업로드"
                      description="어시스턴트에게 첨부"
                      disabled={!onUploadFiles || isRunning}
                      onClick={() => imageInputRef.current?.click()}
                    />
                    <div className="context-menu-divider" />
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
                      const verified = VERIFIED_IMAGE_GENERATION_MODEL_IDS.has(
                        model.id,
                      );
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
          <ComposerMenuButton
            label={`${permissionOption.warning ? '⚠ ' : ''}${permissionOption.pillLabel}`}
            title="권한 방식"
            active={openMenu === 'permission'}
            emphasis={permissionOption.warning}
            onToggle={() => toggleMenu('permission')}
          >
            {openMenu === 'permission' ? (
              <div className="composer-menu" role="menu">
                {PERMISSION_MODE_OPTIONS.map((option) => (
                  <MenuOptionRow
                    key={option.value}
                    title={`${option.warning ? '⚠ ' : ''}${option.label}`}
                    description={option.description}
                    warning={option.warning}
                    checked={option.value === permissionMode}
                    onClick={() => {
                      onPermissionModeChange(option.value);
                      closeMenu();
                    }}
                  />
                ))}
              </div>
            ) : null}
          </ComposerMenuButton>
        </span>

        <span className="composer-footer-group">
          <ContextUsageRing contextUsage={contextUsage} modelId={modelId} />
          <ComposerMenuButton
            label={`${model.label} ${effortLabel} ∨`}
            title="모델과 사고 강도"
            active={openMenu === 'model'}
            onToggle={() => toggleMenu('model')}
          >
            {openMenu === 'model' ? (
              <div className="composer-menu align-right" role="menu">
                {modelMenuPage === 'root' ? (
                  <>
                    {RUN_MODEL_CATALOG.map((option) => (
                      <MenuOptionRow
                        key={option.id}
                        title={option.label}
                        description={RUN_MODEL_TAGLINES[option.id]}
                        checked={option.id === modelId}
                        disabled={
                          option.id !== modelId && (isBusy || isRunning)
                        }
                        onClick={() => {
                          onModelIdChange(option.id);
                          closeMenu();
                        }}
                      />
                    ))}
                    <div className="context-menu-divider" />
                    <MenuNavRow
                      label="사고 강도"
                      value={effortLabel}
                      onClick={() => setModelMenuPage('effort')}
                    />
                    <MenuNavRow
                      label="서브에이전트"
                      value={subagentValueLabel}
                      onClick={() => setModelMenuPage('subagent')}
                    />
                  </>
                ) : null}

                {modelMenuPage === 'effort' ? (
                  <>
                    <MenuBackRow
                      label="사고 강도"
                      onClick={() => setModelMenuPage('root')}
                    />
                    <div className="composer-menu-note">
                      {REASONING_EFFORT_NOTE}
                    </div>
                    {RUN_REASONING_EFFORTS.filter((effort) =>
                      model.reasoningEfforts.some(
                        (candidate) => candidate === effort,
                      ),
                    ).map((effort) => (
                      <MenuOptionRow
                        key={effort}
                        title={REASONING_EFFORT_LABELS[effort]}
                        {...(effort === model.defaultReasoningEffort
                          ? { badge: '기본값' }
                          : {})}
                        checked={effort === reasoningEffort}
                        onClick={() => {
                          onReasoningEffortChange(effort);
                          closeMenu();
                        }}
                      />
                    ))}
                  </>
                ) : null}

                {modelMenuPage === 'subagent' ? (
                  <>
                    <MenuBackRow
                      label="서브에이전트"
                      onClick={() => setModelMenuPage('root')}
                    />
                    <div className="composer-menu-note">
                      보조 작업(worker·explorer)이 어떤 모델을 쓸지 정합니다.
                    </div>
                    <MenuOptionRow
                      title="자동"
                      description="호출하는 에이전트가 모델을 고릅니다"
                      checked={subagentModelRouting.mode === 'auto'}
                      onClick={() => {
                        onSubagentModelRoutingChange(
                          DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
                        );
                        closeMenu();
                      }}
                    />
                    {RUN_MODEL_CATALOG.map((option) => (
                      <MenuOptionRow
                        key={option.id}
                        title={`${option.label} 고정`}
                        description={RUN_MODEL_TAGLINES[option.id]}
                        checked={
                          subagentModelRouting.mode === 'fixed' &&
                          subagentModelRouting.choice.modelId === option.id
                        }
                        onClick={() => {
                          onSubagentModelRoutingChange({
                            mode: 'fixed',
                            choice: { modelId: option.id },
                          });
                          setModelMenuPage('subagent-effort');
                        }}
                      />
                    ))}
                    {subagentModelRouting.mode === 'fixed' ? (
                      <MenuNavRow
                        label="고정 모델 사고 강도"
                        value={
                          fixedSubagentEffort === undefined
                            ? '기본'
                            : REASONING_EFFORT_LABELS[fixedSubagentEffort]
                        }
                        onClick={() => setModelMenuPage('subagent-effort')}
                      />
                    ) : null}
                  </>
                ) : null}

                {modelMenuPage === 'subagent-effort' &&
                subagentModelRouting.mode === 'fixed' &&
                fixedSubagentModel !== null ? (
                  <>
                    <MenuBackRow
                      label={`${fixedSubagentModel.label} 사고 강도`}
                      onClick={() => setModelMenuPage('subagent')}
                    />
                    <MenuOptionRow
                      title="기본"
                      description={`${fixedSubagentModel.label} 기본 사고 강도`}
                      checked={fixedSubagentEffort === undefined}
                      onClick={() => {
                        onSubagentModelRoutingChange({
                          mode: 'fixed',
                          choice: {
                            modelId: subagentModelRouting.choice.modelId,
                          },
                        });
                        closeMenu();
                      }}
                    />
                    {RUN_REASONING_EFFORTS.filter((effort) =>
                      fixedSubagentModel.reasoningEfforts.some(
                        (candidate) => candidate === effort,
                      ),
                    ).map((effort) => (
                      <MenuOptionRow
                        key={effort}
                        title={REASONING_EFFORT_LABELS[effort]}
                        {...(effort ===
                        fixedSubagentModel.defaultReasoningEffort
                          ? { badge: '기본값' }
                          : {})}
                        checked={effort === fixedSubagentEffort}
                        onClick={() => {
                          onSubagentModelRoutingChange({
                            mode: 'fixed',
                            choice: {
                              modelId: subagentModelRouting.choice.modelId,
                              reasoningEffort: effort,
                            },
                          });
                          closeMenu();
                        }}
                      />
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </ComposerMenuButton>
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        name="workspace-file-upload"
        aria-label="파일 업로드"
        title="파일 업로드"
        multiple
        hidden
        onChange={(event) => handleUpload(event.target.files)}
      />
      <input
        ref={imageInputRef}
        type="file"
        name="workspace-image-upload"
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

const CONTEXT_TOKEN_FORMATTER = new Intl.NumberFormat('ko-KR');
const CONTEXT_PERCENT_FORMATTER = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 1,
});

function ContextUsageRing(props: {
  contextUsage: ContextUsageUpdatedEventPayload | null;
  modelId: RunModelId;
}) {
  const snapshot =
    props.contextUsage?.modelId === props.modelId ? props.contextUsage : null;
  const measuredProgress =
    snapshot?.state === 'measured'
      ? Math.min(100, (snapshot.inputTokens / snapshot.thresholdTokens) * 100)
      : 0;
  const previousProgress =
    snapshot === null
      ? 0
      : Math.min(100, (snapshot.inputTokens / snapshot.thresholdTokens) * 100);
  const tooltip = formatContextUsageTooltip(snapshot, previousProgress);

  return (
    <span
      className="context-usage-ring"
      role="img"
      tabIndex={0}
      aria-label={tooltip}
      title={tooltip}
      data-tooltip={tooltip}
      data-state={snapshot?.state ?? 'unknown'}
      data-percentage={CONTEXT_PERCENT_FORMATTER.format(measuredProgress)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle
          className="context-usage-ring-track"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
        />
        <circle
          className="context-usage-ring-value"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - measuredProgress}
        />
      </svg>
    </span>
  );
}

function formatContextUsageTooltip(
  snapshot: ContextUsageUpdatedEventPayload | null,
  progress: number,
): string {
  if (snapshot === null) {
    return '컨텍스트 0%';
  }

  const percentage = CONTEXT_PERCENT_FORMATTER.format(progress);
  const tokens = `${CONTEXT_TOKEN_FORMATTER.format(snapshot.inputTokens)} / ${CONTEXT_TOKEN_FORMATTER.format(snapshot.thresholdTokens)} 토큰`;
  if (snapshot.state === 'compacted') {
    return `컨텍스트 압축 완료 · 직전 ${percentage}% (${tokens})`;
  }
  return `컨텍스트 ${percentage}% (${tokens})`;
}

function ComposerMenuButton(props: {
  label: string;
  title: string;
  active: boolean;
  emphasis?: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <span className="composer-menu-anchor">
      <button
        type="button"
        className={[
          'composer-pill',
          props.active ? 'active' : '',
          props.emphasis ? 'emphasis' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={props.title}
        onClick={props.onToggle}
      >
        {props.label}
      </button>
      {props.children}
    </span>
  );
}

// 클로드식 2줄 옵션 — 제목(+뱃지) 줄과 회색 설명 줄, 오른쪽 ✓
function MenuOptionRow(props: {
  title: string;
  description?: string;
  badge?: string;
  checked?: boolean;
  warning?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        'context-menu-item',
        'menu-option',
        props.warning ? 'warning' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={props.disabled ?? false}
      onClick={props.onClick}
    >
      <span className="menu-option-main">
        <span className="menu-option-title">
          {props.title}
          {props.badge !== undefined ? (
            <span className="menu-badge">{props.badge}</span>
          ) : null}
        </span>
        {props.description !== undefined ? (
          <span className="menu-option-desc">{props.description}</span>
        ) : null}
      </span>
      {props.checked ? <span className="menu-option-check">✓</span> : null}
    </button>
  );
}

// 서브패널로 들어가는 행 — 현재 값과 › 를 오른쪽에 보여준다
function MenuNavRow(props: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu-item menu-nav-row"
      onClick={props.onClick}
    >
      <span className="menu-option-title">{props.label}</span>
      <span className="menu-nav-value">
        {props.value} <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}

function MenuBackRow(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu-item menu-back-row"
      onClick={props.onClick}
    >
      <span aria-hidden="true">‹</span> {props.label}
    </button>
  );
}
