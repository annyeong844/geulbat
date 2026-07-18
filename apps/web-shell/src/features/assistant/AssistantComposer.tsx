import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  IMAGE_GENERATION_MODEL_CATALOG,
  RUN_MODEL_CATALOG,
  RUN_REASONING_EFFORTS,
  VIDEO_GENERATION_MODEL_CATALOG,
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
  const openVideoSettings = () => setVideoSettingsOpen(true);
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

  return (
    <div className="composer">
      {imageModelNotice !== null ? (
        <div className="branch-notice" role="status">
          <span className="branch-notice-text">{imageModelNotice}</span>
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
