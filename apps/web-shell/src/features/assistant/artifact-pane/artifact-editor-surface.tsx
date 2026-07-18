import { createElement, useEffect, useRef, useState } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import { getErrorMessage } from '@geulbat/shared-utils/error';

import { LineNumberedCodeArea } from '../../../lib/code-area/line-numbered-code-area.js';
import { saveTextToLocalFile } from '../../../lib/save-local-file.js';
import { buildArtifactSessionKey } from '../../artifacts/artifact-pane-view-model.js';
import { buildCommittedArtifactSourceRef } from '../../artifacts/artifact-source-ref.js';
import { createCommittedArtifactViewModel } from '../../artifacts/artifact-view-model.js';
import { ArtifactPreviewSurface } from '../../artifacts/artifact-pane/body.js';
import { buildDirectSaveTarget } from '../../artifacts/artifact-pane/controller-model.js';
import { buildArtifactPaneStateModel } from '../../artifacts/artifact-pane/state-model.js';
import { useArtifactPanePreviewSurface } from '../../artifacts/artifact-pane/use-artifact-pane-preview-surface.js';
import type { RenderArtifactRuntimeFrame } from '../../artifacts/runtime-preview/types.js';
import { ArtifactRuntimeFrame } from '../runtime-frame/artifact-runtime-frame.js';

// 에디터 표면에서는 프레임을 카드 크롬 없이(inline variant) 그린다 —
// 콘텐츠가 시트를 가득 채우고 중첩 박스가 생기지 않는다.
const renderEditorRuntimeFrame: RenderArtifactRuntimeFrame = (args) =>
  createElement(ArtifactRuntimeFrame, { ...args, variant: 'inline' });

// 에디터 표면의 아티팩트 본문 — 클로드 아티팩트 헤더와 같은 문법:
// 좌측 [👁 프리뷰 | </> 원문] 아이콘 토글 + 이름·타입, 우측 복사 · ♻ 다시
// 만들기(부분/전체 라우팅은 모델 몫) · 저장 · 확대/축소. 생성 중에는 원문
// 모드에서 코드가 타이핑되듯 흘러들어오고, 끝나면 프리뷰로 자동 전환된다.
export type ArtifactEditorSurfaceMode = 'render' | 'code';

export function ArtifactEditorSurface(props: {
  artifact: ThreadArtifactVersion;
  // 런타임 persistence scope의 신뢰 컨텍스트 — 아티팩트 sourceRef에
  // threadId가 없으면(스트리밍 커밋 직후 등) 여기서 보충한다. 없으면
  // 프레임 스토리지가 scope 불가로 강등되며 콘솔 에러가 반복된다.
  threadId: string | null;
  isRunning: boolean;
  mode: ArtifactEditorSurfaceMode;
  onSelectMode: (mode: ArtifactEditorSurfaceMode) => void;
  // null이면 즉시 표시(참조 칩 클릭 등), 값이 바뀌면 새 스트리밍 표시 시작
  streamToken: number | null;
  // 코드 타이핑이 끝났을 때 — 부모가 프리뷰 모드로 자동 전환한다
  onStreamRevealDone?: () => void;
  // ♻ 다시 만들기 — 문제 정도 판단과 부분/전체 라우팅은 모델의 몫
  onRewrite?: () => void;
  // 확대 — 채팅 컬럼을 밀어내고 [탐색기 | 아티팩트] 레이아웃으로 커진다.
  // 상태는 워크스페이스가 소유하고 여기서는 토글만 요청한다.
  expanded: boolean;
  onToggleExpand: () => void;
  // 같은 artifactId의 버전 목록(버전 오름차순) — 헤더의 ← v{n} → 스테퍼가
  // 넘겨본다. 2개 미만이면 스테퍼 없이 v{n} 텍스트만 남는다.
  versionHistory?: ThreadArtifactVersion[];
  onSelectVersion?: (artifact: ThreadArtifactVersion) => void;
  // </>에서 고친 draft를 같은 아티팩트의 새 버전으로 커밋 — 성공 시 부모가
  // 새 버전을 내려보내 draft가 초기화된다. 실패(409 등)는 여기서 표시.
  onCommitDraft?: (draftPayload: string) => Promise<void>;
}) {
  const {
    artifact,
    threadId,
    isRunning,
    mode,
    onSelectMode,
    streamToken,
    onStreamRevealDone,
    onRewrite,
    expanded,
    onToggleExpand,
    versionHistory,
    onSelectVersion,
    onCommitDraft,
  } = props;
  // 사용자 편집 draft — 원문(</>)에서 고치면 프리뷰/저장이 draft를 쓴다.
  // 새 버전이 도착하면 초기화.
  const [draft, setDraft] = useState<string | null>(null);
  const artifactIdentity = `${artifact.artifactId}:${artifact.version}`;
  useEffect(() => {
    setDraft(null);
  }, [artifactIdentity]);
  const effectiveArtifact =
    draft === null || draft === artifact.payload
      ? artifact
      : { ...artifact, payload: draft };
  const baseSourceRef = buildCommittedArtifactSourceRef(effectiveArtifact);
  const sourceRef =
    baseSourceRef.threadId || threadId === null
      ? baseSourceRef
      : { ...baseSourceRef, threadId };
  const viewModel = createCommittedArtifactViewModel({
    artifact: effectiveArtifact,
    sourceRef,
  });
  const artifactSessionKey = buildArtifactSessionKey(viewModel);
  const paneStateModel = buildArtifactPaneStateModel({
    viewModel,
    isRunning,
    hasStartArtifactRunHandler: false,
  });
  const { previewSurface, runtimeUnavailableMessage } =
    useArtifactPanePreviewSurface({
      viewModel,
      artifactSessionKey,
      canShowPreview: paneStateModel.canShowPreview,
      supportsStreamingPreview: paneStateModel.supportsStreamingPreview,
      isLiveStreamingArtifact: false,
      renderRuntimeFrame: renderEditorRuntimeFrame,
    });
  const reveal = useArtifactCodeReveal(
    artifact.payload,
    streamToken,
    onStreamRevealDone,
  );
  const directSave = buildDirectSaveTarget(viewModel);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef(0);
  const draftDirty = draft !== null && draft !== artifact.payload;
  // 스테퍼 좌표 — 현재 표시 중인 버전이 목록의 몇 번째인지
  const versionIndex =
    versionHistory?.findIndex(
      (candidate) => candidate.version === artifact.version,
    ) ?? -1;
  const previousVersion =
    versionHistory !== undefined && versionIndex > 0
      ? versionHistory[versionIndex - 1]
      : undefined;
  const nextVersion =
    versionHistory !== undefined &&
    versionIndex >= 0 &&
    versionIndex < versionHistory.length - 1
      ? versionHistory[versionIndex + 1]
      : undefined;
  const showVersionStepper =
    versionHistory !== undefined &&
    versionHistory.length > 1 &&
    onSelectVersion !== undefined;

  useEffect(() => {
    return () => window.clearTimeout(copyResetTimer.current);
  }, []);

  const handleSave = async () => {
    if (directSave === null || savePending) {
      return;
    }
    setSavePending(true);
    setSaveError(null);
    try {
      await saveTextToLocalFile({
        suggestedName: directSave.defaultPath,
        payload: directSave.payload,
      });
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error));
    } finally {
      setSavePending(false);
    }
  };

  const handleCommitDraft = async () => {
    if (onCommitDraft === undefined || !draftDirty || commitPending) {
      return;
    }
    setCommitPending(true);
    setCommitError(null);
    try {
      await onCommitDraft(draft);
    } catch (error: unknown) {
      setCommitError(getErrorMessage(error));
    } finally {
      setCommitPending(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.payload);
      setCopied(true);
      window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // 클립보드 권한이 없으면 조용히 둔다 — 원문은 코드 모드에서 보인다
    }
  };

  const title =
    artifact.title !== null && artifact.title.trim() !== ''
      ? artifact.title
      : '아티팩트';

  return (
    <>
      <div className="artifact-editor-surface">
        <div className="artifact-editor-toolbar">
          <span
            className="artifact-editor-mode-toggle"
            role="group"
            aria-label="아티팩트 보기 모드"
          >
            <button
              type="button"
              className={`artifact-editor-icon-button${mode === 'render' ? ' active' : ''}`}
              title="프리뷰"
              aria-pressed={mode === 'render'}
              onClick={() => onSelectMode('render')}
            >
              <EyeIcon />
            </button>
            <button
              type="button"
              className={`artifact-editor-icon-button${mode === 'code' ? ' active' : ''}`}
              title="원문 보기"
              aria-pressed={mode === 'code'}
              onClick={() => onSelectMode('code')}
            >
              <CodeIcon />
            </button>
          </span>
          <span className="artifact-editor-title">{title}</span>
          <span className="artifact-editor-meta">
            · {artifact.renderer} ·{' '}
            {showVersionStepper ? (
              <span
                className="artifact-editor-version-stepper"
                role="group"
                aria-label="아티팩트 버전 이동"
              >
                <button
                  type="button"
                  className="artifact-editor-icon-button version-step"
                  title={
                    previousVersion !== undefined
                      ? `이전 버전 (v${previousVersion.version})`
                      : '첫 버전'
                  }
                  aria-label="이전 버전"
                  disabled={previousVersion === undefined}
                  onClick={() =>
                    previousVersion !== undefined
                      ? onSelectVersion?.(previousVersion)
                      : undefined
                  }
                >
                  ←
                </button>
                <span aria-live="polite">
                  v{artifact.version}/
                  {versionHistory?.at(-1)?.version ?? artifact.version}
                </span>
                <button
                  type="button"
                  className="artifact-editor-icon-button version-step"
                  title={
                    nextVersion !== undefined
                      ? `다음 버전 (v${nextVersion.version})`
                      : '최신 버전'
                  }
                  aria-label="다음 버전"
                  disabled={nextVersion === undefined}
                  onClick={() =>
                    nextVersion !== undefined
                      ? onSelectVersion?.(nextVersion)
                      : undefined
                  }
                >
                  →
                </button>
              </span>
            ) : (
              <>v{artifact.version}</>
            )}
            {mode === 'code' && !reveal.done ? ' · 코드 작성 중…' : ''}
            {draftDirty ? ' · 수정됨' : ''}
          </span>
          <span className="artifact-editor-toolbar-spacer" />
          <button
            type="button"
            className="artifact-editor-icon-button"
            title={copied ? '복사됨' : '원문 복사'}
            onClick={() => void handleCopy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {onRewrite !== undefined ? (
            <button
              type="button"
              className="artifact-editor-icon-button"
              title="다시 만들기 — 문제 정도에 따라 부분 수정과 전체 재작성을 알아서 고릅니다"
              disabled={isRunning}
              onClick={onRewrite}
            >
              <RecycleIcon />
            </button>
          ) : null}
          {onCommitDraft !== undefined && draftDirty ? (
            <button
              type="button"
              className="artifact-editor-action"
              title="고친 내용을 이 아티팩트의 새 버전으로 커밋"
              disabled={commitPending}
              onClick={() => void handleCommitDraft()}
            >
              {commitPending ? '커밋 중…' : '버전 커밋'}
            </button>
          ) : null}
          {directSave !== null ? (
            <button
              type="button"
              className="artifact-editor-action"
              title="원문을 로컬 파일로 저장"
              disabled={savePending}
              onClick={() => void handleSave()}
            >
              {savePending ? '저장 중…' : '저장'}
            </button>
          ) : null}
          <button
            type="button"
            className="artifact-editor-icon-button"
            title={expanded ? '원래 크기로' : '확대 — 채팅을 접고 넓게 보기'}
            aria-pressed={expanded}
            onClick={onToggleExpand}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        </div>
        {saveError !== null ? (
          <div className="artifact-editor-error" role="alert">
            저장 실패: {saveError}
          </div>
        ) : null}
        {commitError !== null ? (
          <div className="artifact-editor-error" role="alert">
            버전 커밋 실패: {commitError}
          </div>
        ) : null}
        {mode === 'code' ? (
          !reveal.done ? (
            <LineNumberedCodeArea
              value={reveal.visibleCode}
              ariaLabel="아티팩트 원문 (작성 중)"
              readOnly
            />
          ) : (
            <LineNumberedCodeArea
              value={draft ?? artifact.payload}
              ariaLabel="아티팩트 원문"
              onChange={setDraft}
            />
          )
        ) : (
          <div className="artifact-editor-body">
            {paneStateModel.canShowPreview && previewSurface !== null ? (
              <ArtifactPreviewSurface
                surface={previewSurface}
                runtimeUnavailableMessage={runtimeUnavailableMessage}
              />
            ) : (
              <LineNumberedCodeArea
                value={draft ?? artifact.payload}
                ariaLabel="아티팩트 원문"
                onChange={setDraft}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

// 표현 계층 점진 표시 — visualize 위젯의 점진 렌더와 같은 페이싱(45ms 스텝,
// 전체 0.6~2.5초)을 쓰되, 코드는 줄 경계로 잘라 타이핑되듯 흘러들어온다.
// prefers-reduced-motion이면 즉시 완료. 완료 시 onDone을 한 번 부른다.
function useArtifactCodeReveal(
  code: string,
  streamToken: number | null,
  onDone?: () => void,
): { visibleCode: string; done: boolean } {
  const [state, setState] = useState<{ visibleCode: string; done: boolean }>({
    visibleCode: code,
    done: true,
  });
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (streamToken === null) {
      setState({ visibleCode: code, done: true });
      return;
    }
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setState({ visibleCode: code, done: true });
      onDoneRef.current?.();
      return;
    }
    const segments = code.split(/(?<=\n)/);
    const total = segments.length;
    const durationMs = Math.max(600, Math.min(2500, total * 45));
    const stepMs = 45;
    const steps = Math.max(1, Math.round(durationMs / stepMs));
    const chunk = Math.max(1, Math.ceil(total / steps));
    let index = 0;
    let timer = 0;
    let cancelled = false;
    setState({ visibleCode: '', done: false });
    const tick = () => {
      if (cancelled) {
        return;
      }
      index = Math.min(total, index + chunk);
      const done = index >= total;
      setState({ visibleCode: segments.slice(0, index).join(''), done });
      if (!done) {
        timer = window.setTimeout(tick, stepMs);
      } else {
        onDoneRef.current?.();
      }
    };
    timer = window.setTimeout(tick, stepMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, streamToken]);

  return state;
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="17 17 22 12 17 7" />
      <polyline points="7 7 2 12 7 17" />
      <line x1="14" y1="5" x2="10" y2="19" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RecycleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
