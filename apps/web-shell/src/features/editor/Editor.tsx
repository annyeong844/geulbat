import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';

import { baseNameOf } from '../../lib/path-name.js';
import { LineNumberedCodeArea } from '../../lib/code-area/line-numbered-code-area.js';
import { RichTextArea, type RichTextAreaHandle } from './RichTextArea.js';
import { richMarkdownToHtml } from './rich-text-codec.js';
import { BinaryPreviewViewer } from './BinaryPreviewViewer.js';
import { FormatToolbar, useRichFormatToolbar } from './FormatToolbar.js';

import {
  countWords,
  formatSaveStateLabel,
  isCodeFileName,
  splitBreadcrumb,
  type ManuscriptViewMode,
} from './manuscript-view-prefs.js';

// 열린 파일 탭 하나 — app 훅(use-computer-files)이 이 shape로 공급한다
export interface OpenFileTab {
  path: string;
  isDirty: boolean;
}

interface Props {
  filePath: string | null;
  extractedDocument?: 'docx' | 'xlsx' | 'hwpx' | null;
  binaryPreview?: {
    path: string;
    kind: 'image' | 'audio' | 'video' | 'unsupported';
    url?: string;
    byteSize?: number;
  } | null;
  content: string;
  isDirty: boolean;
  saving: boolean;
  openingFile: boolean;
  lastSavedAt: number | null;
  uiError: string | null;
  saveConflict: ConflictStaleWriteError | null;
  readOnly?: boolean;
  openFiles?: OpenFileTab[];
  onSelectFileTab?: (path: string) => void;
  onCloseFileTab?: (path: string) => void;
  onChange: (content: string) => void;
  onSave: () => Promise<void> | void;
  onConflictReload: () => Promise<void> | void;
  onConflictSaveAsCopy: () => Promise<void> | void;
  onConflictInspect: () => Promise<string | null>;
  // 열린 아티팩트가 있으면 리치 에디터 | 아티팩트 | 코드 뷰어 토글에
  // 아티팩트 필이 끼어든다 — 별도 패널이 아니라 이 편집기 표면의 보기
  // 모드다. active면 원고 시트 자리에 artifactSurface가 렌더되고,
  // 리치 에디터/코드 뷰어를 고르면 onExit로 파일 편집기로 돌아간다.
  // (아티팩트 원문 보기는 artifactSurface 자체의 👁/</> 토글 몫 — 코드
  // 뷰어는 항상 파일 편집이다.)
  artifactPill?: {
    label: string;
    active: boolean;
    onOpen: () => void;
    onExit: () => void;
  };
  // 아티팩트 모드일 때 원고 시트 자리에 그릴 본문
  artifactSurface?: ReactNode;
}

type CenterTab = 'manuscript' | 'canvas';

// 이 크기를 넘으면 리치 렌더 대신 코드 뷰로 연다 (수 MB md 28초 방지)
const LARGE_RICH_DOCUMENT_BYTES = 256 * 1024;

/**
 * 중앙 — 원고 sanctuary (§3.2). plain editor 유지 (§3.2.3).
 *
 * 캔버스 탭은 shell surface만 — 실제 iframe mount는 P5 canvas display
 * surface API land 후 §7.2 integration closeout owner (§3.4).
 */
export function Editor({
  filePath,
  extractedDocument = null,
  binaryPreview = null,
  content,
  isDirty,
  saving,
  openingFile,
  lastSavedAt,
  uiError,
  saveConflict,
  readOnly: daemonReadOnly = false,
  openFiles = [],
  onSelectFileTab,
  onCloseFileTab,
  onChange,
  onSave,
  onConflictReload,
  onConflictSaveAsCopy,
  onConflictInspect,
  artifactPill,
  artifactSurface,
}: Props) {
  // 오피스 추출본은 항상 읽기 전용 — 저장하면 원본 바이너리가 파괴된다
  const readOnly = daemonReadOnly || extractedDocument !== null;

  // 파일 단위 보기 모드 override — 파일이 바뀌면 자동 감지로 복귀
  const [viewOverride, setViewOverride] = useState<ManuscriptViewMode | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<CenterTab>('manuscript');
  const [hasCanvasTab, setHasCanvasTab] = useState(false);
  const [dropRejected, setDropRejected] = useState(false);
  const [conflictPreview, setConflictPreview] = useState<string | null>(null);
  const richTextAreaRef = useRef<RichTextAreaHandle | null>(null);
  // save state relative label 갱신용 tick
  const [, setNowTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setConflictPreview(null);
  }, [saveConflict, filePath]);

  useEffect(() => {
    setViewOverride(null);
  }, [filePath]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!filePath || !isDirty || saving || readOnly) {
          return;
        }
        void onSave();
      }
    },
    [filePath, isDirty, saving, readOnly, onSave],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // 리치/코드 토글 — 아티팩트 모드 중이었다면 파일 편집기로 복귀시킨다
  const selectViewMode = useCallback(
    (mode: ManuscriptViewMode) => {
      if (artifactPill?.active) {
        artifactPill.onExit();
      }
      setViewOverride(mode);
    },
    [artifactPill],
  );

  // drop affordance — P8 handler 미존재: rejection 분기만 (§3.2.4)
  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
    setDropRejected(true);
  }, []);

  const handleDragLeave = useCallback(() => setDropRejected(false), []);

  const handleDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    setDropRejected(false);
  }, []);

  const handleConflictInspect = useCallback(async () => {
    const current = await onConflictInspect();
    setConflictPreview(current);
  }, [onConflictInspect]);

  const closeCanvasTab = useCallback(() => {
    setHasCanvasTab(false);
    setActiveTab('manuscript');
  }, []);

  const handleOpenFileTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
      let nextIndex: number | null = null;
      switch (event.key) {
        case 'ArrowLeft':
          nextIndex = (tabIndex - 1 + openFiles.length) % openFiles.length;
          break;
        case 'ArrowRight':
          nextIndex = (tabIndex + 1) % openFiles.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = openFiles.length - 1;
          break;
        default:
          return;
      }

      const nextTab = openFiles[nextIndex];
      if (!nextTab) {
        return;
      }
      event.preventDefault();
      onSelectFileTab?.(nextTab.path);
      const tabButtons = event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      tabButtons?.[nextIndex]?.focus();
    },
    [onSelectFileTab, openFiles],
  );

  const formatToolbar = useRichFormatToolbar({ readOnly, richTextAreaRef });

  const wordCount = useMemo(() => countWords(content), [content]);
  const breadcrumbItems = filePath ? splitBreadcrumb(filePath) : [];
  const fileName = breadcrumbItems[breadcrumbItems.length - 1] ?? '';
  const saveFailed = uiError !== null && isDirty;
  const saveStateLabel = filePath
    ? formatSaveStateLabel({ saving, isDirty, saveFailed, lastSavedAt })
    : '';
  // 대형 문서는 contentEditable 대신 정적 읽기 뷰로 렌더한다 —
  // 소설 같은 긴 원고도 리치하게 읽히고, 편집은 코드 뷰가 담당.
  const isLargeDocument = content.length > LARGE_RICH_DOCUMENT_BYTES;
  const viewMode: ManuscriptViewMode =
    viewOverride ?? (isCodeFileName(fileName) ? 'code' : 'rich');
  const proseClass = viewMode === 'code' ? 'prose-code' : 'prose-rich';
  // 아티팩트 보기 모드 — 원고 시트 자리를 아티팩트 본문이 차지한다
  const artifactActive =
    artifactPill?.active === true && artifactSurface !== undefined;

  return (
    <>
      {openFiles.length > 0 ? (
        <div className="file-tabs" role="tablist" aria-label="열린 파일">
          {openFiles.map((tab, tabIndex) => (
            <div
              key={tab.path}
              className={`file-tab${tab.path === filePath ? ' active' : ''}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.path === filePath}
                tabIndex={tab.path === filePath ? 0 : -1}
                className="file-tab-select"
                onClick={() => onSelectFileTab?.(tab.path)}
                onKeyDown={(event) => handleOpenFileTabKeyDown(event, tabIndex)}
              >
                <span className="file-tab-label">
                  {baseNameOf(tab.path)}
                  {tab.isDirty ? ' ●' : ''}
                </span>
              </button>
              <button
                type="button"
                className="file-tab-close"
                aria-label={`${tab.path} 닫기`}
                onClick={() => onCloseFileTab?.(tab.path)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="manuscript-header">
        <nav className="breadcrumb" aria-label="파일 경로">
          {breadcrumbItems.map((item, index) => (
            <BreadcrumbItem
              key={`${item}-${index}`}
              isLast={index === breadcrumbItems.length - 1}
            >
              {item}
            </BreadcrumbItem>
          ))}
        </nav>

        <div className="manuscript-meta-row">
          <div className="manuscript-title">
            {filePath ? fileName.replace(/\.[^.]+$/, '') : ''}
          </div>
          {filePath || artifactPill !== undefined ? (
            <div className="manuscript-meta">
              {filePath && viewMode === 'code' && !artifactActive ? (
                // 코드 뷰어에는 서식 툴바(💾 포함)가 없다 — 저장 버튼을
                // 헤더에 직접 둔다 (Ctrl+S도 동작).
                <>
                  <button
                    type="button"
                    className="pref-toggle"
                    title="저장 (Ctrl+S)"
                    disabled={readOnly || !isDirty || saving}
                    onClick={() => void onSave()}
                  >
                    {saving ? '저장 중…' : '저장'}
                  </button>
                  <span className="meta-divider">·</span>
                </>
              ) : null}
              {filePath ? (
                <>
                  <span>{wordCount.toLocaleString()} 단어</span>
                  {saveStateLabel ? (
                    <>
                      <span className="meta-divider">·</span>
                      <span
                        className={[
                          'save-state',
                          saving ? 'saving' : '',
                          saveFailed ? 'failed' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <span className="save-state-dot" />
                        <span>{saveStateLabel}</span>
                        {saveFailed ? (
                          <button type="button" onClick={() => void onSave()}>
                            재시도
                          </button>
                        ) : null}
                      </span>
                    </>
                  ) : null}
                  <span className="meta-divider">·</span>
                </>
              ) : null}
              <span className="manuscript-prefs">
                <button
                  type="button"
                  className={`pref-toggle${!artifactActive && viewMode === 'rich' ? ' active' : ''}`}
                  title="리치 에디터 — 본문 서체로 편집"
                  onClick={() => selectViewMode('rich')}
                >
                  리치 에디터
                </button>
                {artifactPill !== undefined ? (
                  <button
                    type="button"
                    className={`pref-toggle${artifactActive ? ' active' : ''}`}
                    title={`아티팩트 — ${artifactPill.label}`}
                    onClick={artifactPill.onOpen}
                  >
                    아티팩트
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`pref-toggle${!artifactActive && viewMode === 'code' ? ' active' : ''}`}
                  title="코드 뷰어 — 고정폭 서체, 줄바꿈 없음"
                  onClick={() => selectViewMode('code')}
                >
                  코드 뷰어
                </button>
              </span>
            </div>
          ) : null}
        </div>

        {hasCanvasTab ? (
          <div className="mode-tabs">
            <div className="mode-tab-list" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'manuscript'}
                className={`mode-tab${activeTab === 'manuscript' ? ' active' : ''}`}
                onClick={() => setActiveTab('manuscript')}
              >
                원고
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'canvas'}
                className={`mode-tab${activeTab === 'canvas' ? ' active' : ''}`}
                onClick={() => setActiveTab('canvas')}
              >
                캔버스
              </button>
            </div>
            <button
              type="button"
              className="mode-tab-close"
              aria-label="캔버스 닫기"
              onClick={closeCanvasTab}
            >
              ✕
            </button>
          </div>
        ) : null}

        {filePath && !openingFile && viewMode !== 'code' && !artifactActive ? (
          <FormatToolbar
            controller={formatToolbar}
            isDirty={isDirty}
            saving={saving}
            onSave={onSave}
          />
        ) : null}
      </div>

      <div className="manuscript-scroll">
        {/* Drop handlers only reject unsupported file drops; they do not make the article an interactive control. */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <article
          className={[
            'manuscript-sheet',
            viewMode === 'code' && !artifactActive ? 'code' : '',
            artifactActive ? 'artifact-mode' : '',
            dropRejected ? 'drop-rejected' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {uiError ? (
            <div role="alert" className="editor-alert">
              {uiError}
            </div>
          ) : null}

          {extractedDocument !== null && filePath ? (
            <div className="manuscript-readonly-note" role="status">
              {extractedDocument.toUpperCase()} 문서에서 추출한 텍스트입니다 —
              읽기 전용이며, 원본 문서는 그대로 보존됩니다.
            </div>
          ) : null}
          {daemonReadOnly && filePath ? (
            <div className="manuscript-readonly-note" role="status">
              데몬과 연결이 끊겨 읽기 전용입니다.
              {isDirty
                ? ' 저장되지 않은 변경은 화면에 보존되며, 다시 연결되면 저장할 수 있습니다.'
                : ''}
            </div>
          ) : null}

          {saveConflict ? (
            <div className="conflict-card" role="alert" aria-live="assertive">
              <strong>본문이 다른 곳에서 변경되었습니다.</strong>
              <div className="conflict-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => void handleConflictInspect()}
                >
                  현재 파일 확인하기
                </button>
                <button
                  type="button"
                  className="btn-filled"
                  onClick={() => void onConflictSaveAsCopy()}
                >
                  내 변경을 사본으로 저장
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => void onConflictReload()}
                >
                  다시 불러오기
                </button>
              </div>
              {conflictPreview !== null ? (
                <div className="conflict-preview">{conflictPreview}</div>
              ) : null}
            </div>
          ) : null}

          {artifactActive ? (
            artifactSurface
          ) : !filePath ? (
            binaryPreview ? (
              <BinaryPreviewViewer preview={binaryPreview} />
            ) : (
              <ManuscriptEmptyState />
            )
          ) : openingFile ? (
            <ManuscriptSkeleton />
          ) : activeTab === 'canvas' ? (
            <div className="manuscript-empty">
              <div className="manuscript-empty-icon">▦</div>
              <div className="manuscript-empty-hint">
                캔버스 표시는 다음 단계에서 연결됩니다.
              </div>
            </div>
          ) : viewMode === 'rich' && isLargeDocument ? (
            <>
              <div className="manuscript-readonly-note" role="status">
                긴 원고는 읽기 화면으로 보여드려요. 편집하려면 코드 뷰어로
                전환해 주세요.
              </div>
              <div
                className={`manuscript-editable ${proseClass}`}
                style={{
                  fontSize: 18,
                  lineHeight: formatToolbar.lineSpacing / 100,
                }}
                dangerouslySetInnerHTML={{
                  __html: richMarkdownToHtml(content),
                }}
              />
            </>
          ) : viewMode === 'rich' ? (
            <RichTextArea
              ref={richTextAreaRef}
              value={content}
              readOnly={readOnly}
              fontSize={18}
              lineHeight={formatToolbar.lineSpacing / 100}
              className={proseClass}
              placeholder="이곳에서 이야기가 시작됩니다…"
              onChange={onChange}
            />
          ) : (
            <LineNumberedCodeArea
              value={content}
              ariaLabel="원고 본문"
              placeholder="이곳에서 이야기가 시작됩니다…"
              readOnly={readOnly}
              onChange={onChange}
            />
          )}
        </article>
      </div>
    </>
  );
}

function BreadcrumbItem(props: { children: ReactNode; isLast: boolean }) {
  return (
    <>
      <span className="breadcrumb-item">{props.children}</span>
      {props.isLast ? null : <span className="breadcrumb-sep">›</span>}
    </>
  );
}

function ManuscriptEmptyState() {
  return (
    <div className="manuscript-empty">
      <div className="manuscript-empty-icon">✎</div>
      <div className="manuscript-empty-title">파일을 열어 시작하세요</div>
      <div className="manuscript-empty-hint">
        왼쪽 파일 트리에서 파일을 열거나, 새 파일을 만들어 시작하세요.
      </div>
    </div>
  );
}

function ManuscriptSkeleton() {
  return (
    <div
      className="manuscript-skeleton"
      role="status"
      aria-label="원고 불러오는 중"
    >
      {[92, 100, 96, 88, 100, 72].map((width, index) => (
        <div
          key={index}
          className="skeleton-line"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}
