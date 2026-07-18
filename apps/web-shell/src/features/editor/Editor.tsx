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

import {
  countWords,
  formatSaveStateLabel,
  isCodeFileName,
  splitBreadcrumb,
  type ManuscriptViewMode,
} from './manuscript-view-prefs.js';

// 열린 파일 탭 하나 — app 훅(use-workspace-files)이 이 shape로 공급한다
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

// 한글(HWP) 크기 목록과 유사한 프리셋
const FONT_SIZE_PRESETS = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 72,
] as const;

// 이 크기를 넘으면 리치 렌더 대신 코드 뷰로 연다 (수 MB md 28초 방지)
const LARGE_RICH_DOCUMENT_BYTES = 256 * 1024;

const LINE_SPACING_PRESETS = [100, 115, 130, 145, 160, 180, 200] as const;

// 정렬 아이콘 — 가로 bar 3개의 정렬로 표현 (HWP 스타일)
function AlignGlyph({
  align,
}: {
  align: 'left' | 'center' | 'right' | 'justify';
}) {
  return (
    <span className={`align-glyph ${align}`} aria-hidden>
      <span className="align-bar long" />
      <span className="align-bar short" />
      <span className="align-bar long" />
    </span>
  );
}

// 기본 글자색 팔레트 — 첫 색이 본문 기본(검정)
const TEXT_COLOR_PALETTE = [
  '#1f1a14',
  '#404040',
  '#808080',
  '#bfbfbf',
  '#ffffff',
  '#b14a3a',
  '#e2574c',
  '#e8927c',
  '#f2c063',
  '#8a6d1f',
  '#5b7f4e',
  '#8fbf6e',
  '#2e6f5e',
  '#3f6f8f',
  '#7fb3d3',
  '#2f4f7f',
  '#6f5f9f',
  '#9f7fbf',
  '#7f3f5f',
  '#bf7f9f',
] as const;

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

  // 리치 모드는 contentEditable — 브라우저 네이티브 서식 커맨드가
  // 실제 굵게/기울임/밑줄/색으로 렌더된다. 저장은 제한 markdown.
  const runRichCommand = useCallback(
    (
      command:
        | 'bold'
        | 'italic'
        | 'underline'
        | 'undo'
        | 'redo'
        | 'justifyLeft'
        | 'justifyCenter'
        | 'justifyRight'
        | 'justifyFull',
    ) => {
      if (readOnly) {
        return;
      }
      document.execCommand(command);
      richTextAreaRef.current?.emitChange();
    },
    [readOnly],
  );

  // 글자색 — '가' 글리프가 현재 색을 보여주고, ▾ 팔레트에서 고른다 (HWP)
  const [textColor, setTextColor] = useState('#1f1a14');
  const [toolbarMenu, setToolbarMenu] = useState<
    'fontsize' | 'color' | 'linespacing' | null
  >(null);
  // 줄간격 — 화면 보기 설정 (%). HWP 기본 160%.
  const [lineSpacing, setLineSpacing] = useState(160);
  useEffect(() => {
    if (toolbarMenu === null) {
      return;
    }
    const close = () => setToolbarMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [toolbarMenu]);
  const applyTextColor = useCallback(
    (color: string) => {
      if (readOnly) {
        return;
      }
      setTextColor(color);
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('foreColor', false, color);
      richTextAreaRef.current?.emitChange();
    },
    [readOnly],
  );

  // 글자 크기 — 한글(HWP)처럼 드래그한 선택 영역에만 적용.
  // 크기 입력창이 포커스를 가져가면 본문 selection이 풀리므로, 입력창
  // 진입 시 선택을 저장해 두고 적용 시 복원한다.
  // execCommand('fontSize', 7) 마커를 실제 px span으로 정규화한다.
  const [selectionFontSize, setSelectionFontSize] = useState(18);
  const savedSelectionRef = useRef<Range | null>(null);
  const rememberEditableSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    const editable = document.querySelector('.manuscript-editable');
    if (editable && editable.contains(range.commonAncestorContainer)) {
      savedSelectionRef.current = range.cloneRange();
    }
  }, []);
  const applySelectionFontSize = useCallback(
    (size: number) => {
      if (readOnly) {
        return;
      }
      const clamped = Math.min(72, Math.max(8, size));
      setSelectionFontSize(clamped);
      const saved = savedSelectionRef.current;
      const selection = window.getSelection();
      if (saved && selection) {
        selection.removeAllRanges();
        selection.addRange(saved);
      }
      document.execCommand('styleWithCSS', false, 'false');
      document.execCommand('fontSize', false, '7');
      document
        .querySelectorAll('.manuscript-editable font[size="7"]')
        .forEach((marker) => {
          const span = document.createElement('span');
          span.style.fontSize = `${clamped}px`;
          span.innerHTML = marker.innerHTML;
          marker.replaceWith(span);
        });
      richTextAreaRef.current?.emitChange();
      savedSelectionRef.current = null;
      (
        document.querySelector('.manuscript-editable') as HTMLElement | null
      )?.focus();
    },
    [readOnly],
  );
  const stepFontSize = useCallback(
    (delta: number) => {
      applySelectionFontSize(selectionFontSize + delta);
    },
    [applySelectionFontSize, selectionFontSize],
  );

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
          <div className="format-toolbar" role="toolbar" aria-label="서식">
            <span
              className="font-size-control"
              title="글자 크기 — 선택 영역에 적용"
            >
              <input
                type="number"
                className="font-size-input"
                name="editor-selection-font-size"
                min={8}
                max={72}
                value={selectionFontSize}
                aria-label="글자 크기"
                disabled={readOnly}
                onFocus={rememberEditableSelection}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) {
                    setSelectionFontSize(next);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applySelectionFontSize(selectionFontSize);
                  }
                }}
              />
              <span className="font-size-unit">pt</span>
              <button
                type="button"
                className="format-btn menu-caret"
                aria-label="글자 크기 목록"
                disabled={readOnly}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  rememberEditableSelection();
                  setToolbarMenu((prev) =>
                    prev === 'fontsize' ? null : 'fontsize',
                  );
                }}
              >
                ▾
              </button>
              {toolbarMenu === 'fontsize' ? (
                <div className="toolbar-menu font-size-menu" role="menu">
                  {FONT_SIZE_PRESETS.map((size) => (
                    <button
                      key={size}
                      type="button"
                      role="menuitem"
                      className={`toolbar-menu-item${
                        size === selectionFontSize ? ' active' : ''
                      }`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        applySelectionFontSize(size);
                        setToolbarMenu(null);
                      }}
                    >
                      {size} pt
                    </button>
                  ))}
                </div>
              ) : null}
              <span className="font-size-arrows">
                <FormatButton
                  label="글자 크게"
                  disabled={readOnly}
                  onClick={() => stepFontSize(1)}
                >
                  ▲
                </FormatButton>
                <FormatButton
                  label="글자 작게"
                  disabled={readOnly}
                  onClick={() => stepFontSize(-1)}
                >
                  ▼
                </FormatButton>
              </span>
            </span>
            <span className="format-divider" />
            <FormatButton
              label="진하게 (Ctrl+B)"
              disabled={readOnly}
              onClick={() => runRichCommand('bold')}
            >
              가
            </FormatButton>
            <FormatButton
              label="기울임 (Ctrl+I)"
              disabled={readOnly}
              onClick={() => runRichCommand('italic')}
            >
              <em>가</em>
            </FormatButton>
            <FormatButton
              label="밑줄 (Ctrl+U)"
              disabled={readOnly}
              onClick={() => runRichCommand('underline')}
            >
              <u>가</u>
            </FormatButton>
            <span className="color-control">
              <FormatButton
                label="글자 색 적용"
                disabled={readOnly}
                onClick={() => applyTextColor(textColor)}
              >
                <span className="color-format-glyph">
                  <span style={{ color: textColor }}>가</span>
                  <span
                    className="color-format-bar"
                    style={{ background: textColor }}
                  />
                </span>
              </FormatButton>
              <button
                type="button"
                className="format-btn menu-caret"
                aria-label="글자 색 팔레트"
                disabled={readOnly}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  setToolbarMenu((prev) => (prev === 'color' ? null : 'color'));
                }}
              >
                ▾
              </button>
              {toolbarMenu === 'color' ? (
                <div className="toolbar-menu color-palette" role="menu">
                  {TEXT_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="menuitem"
                      aria-label={`글자 색 ${color}`}
                      className={`palette-swatch${
                        color === textColor ? ' active' : ''
                      }`}
                      style={{ background: color }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        applyTextColor(color);
                        setToolbarMenu(null);
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </span>
            <span className="format-divider" />
            <FormatButton
              label="왼쪽 정렬"
              disabled={readOnly}
              onClick={() => runRichCommand('justifyLeft')}
            >
              <AlignGlyph align="left" />
            </FormatButton>
            <FormatButton
              label="가운데 정렬"
              disabled={readOnly}
              onClick={() => runRichCommand('justifyCenter')}
            >
              <AlignGlyph align="center" />
            </FormatButton>
            <FormatButton
              label="오른쪽 정렬"
              disabled={readOnly}
              onClick={() => runRichCommand('justifyRight')}
            >
              <AlignGlyph align="right" />
            </FormatButton>
            <FormatButton
              label="양쪽 정렬"
              disabled={readOnly}
              onClick={() => runRichCommand('justifyFull')}
            >
              <AlignGlyph align="justify" />
            </FormatButton>
            <span className="format-divider" />
            <span className="font-size-control" title="줄간격 (%)">
              <input
                type="number"
                className="font-size-input line-spacing-input"
                name="editor-line-spacing"
                min={80}
                max={300}
                step={5}
                value={lineSpacing}
                aria-label="줄간격"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) {
                    setLineSpacing(Math.min(300, Math.max(80, next)));
                  }
                }}
              />
              <span className="font-size-unit">%</span>
              <button
                type="button"
                className="format-btn menu-caret"
                aria-label="줄간격 목록"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  setToolbarMenu((prev) =>
                    prev === 'linespacing' ? null : 'linespacing',
                  );
                }}
              >
                ▾
              </button>
              {toolbarMenu === 'linespacing' ? (
                <div className="toolbar-menu font-size-menu" role="menu">
                  {LINE_SPACING_PRESETS.map((spacing) => (
                    <button
                      key={spacing}
                      type="button"
                      role="menuitem"
                      className={`toolbar-menu-item${
                        spacing === lineSpacing ? ' active' : ''
                      }`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setLineSpacing(spacing);
                        setToolbarMenu(null);
                      }}
                    >
                      {spacing} %
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
            <span className="format-divider" />
            <FormatButton
              label="되돌리기"
              disabled={readOnly}
              onClick={() => runRichCommand('undo')}
            >
              ↶
            </FormatButton>
            <FormatButton
              label="다시 실행"
              disabled={readOnly}
              onClick={() => runRichCommand('redo')}
            >
              ↷
            </FormatButton>
            <span className="format-divider" />
            <FormatButton
              label="저장 (Ctrl+S)"
              disabled={readOnly || !isDirty || saving}
              onClick={() => void onSave()}
            >
              💾
            </FormatButton>
          </div>
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
                style={{ fontSize: 18, lineHeight: lineSpacing / 100 }}
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
              lineHeight={lineSpacing / 100}
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

const IMAGE_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// 이미지 줌 + 오디오/비디오 재생 + 파일 정보 — 미리보기 뷰어.
// The file API exposes media bytes but no caption-track reference. An empty
// <track> would claim captions exist, so this boundary remains an explicit
// exception until the file contract can supply a real caption source.
/* oxlint-disable jsx-a11y/media-has-caption */
function BinaryPreviewViewer({
  preview,
}: {
  preview: {
    path: string;
    kind: 'image' | 'audio' | 'video' | 'unsupported';
    url?: string;
    byteSize?: number;
  };
}) {
  // 'fit' = 화면 맞춤, 숫자 = 실제 픽셀 대비 배율
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  useEffect(() => {
    setZoom('fit');
    setNaturalSize(null);
    setPlaybackFailed(false);
  }, [preview.path]);

  const stepZoom = (direction: 1 | -1) => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      const index = IMAGE_ZOOM_STEPS.findIndex((step) => step >= current);
      const base = index === -1 ? IMAGE_ZOOM_STEPS.length - 1 : index;
      const next = Math.min(
        IMAGE_ZOOM_STEPS.length - 1,
        Math.max(0, base + direction),
      );
      return IMAGE_ZOOM_STEPS[next] ?? 1;
    });
  };

  const infoParts: string[] = [];
  if (naturalSize) {
    infoParts.push(`${naturalSize.width}×${naturalSize.height}`);
  }
  if (preview.byteSize !== undefined) {
    infoParts.push(formatByteSize(preview.byteSize));
  }

  if (
    preview.kind === 'unsupported' ||
    preview.url === undefined ||
    playbackFailed
  ) {
    return (
      <div className="binary-preview">
        <div className="binary-preview-name">{baseNameOf(preview.path)}</div>
        <div className="manuscript-empty">
          <div className="manuscript-empty-icon">▣</div>
          <div className="manuscript-empty-title">
            {playbackFailed
              ? '이 파일은 브라우저가 재생하지 못해요'
              : '미리볼 수 없는 형식이에요'}
          </div>
          <div className="manuscript-empty-hint">
            텍스트, 이미지, 일반 미디어가 아닌 파일은 아직 열람을 지원하지
            않아요. 어시스턴트에게 내용 확인을 부탁할 수 있어요.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="binary-preview">
      <div className="binary-preview-header">
        <span className="binary-preview-name">
          {baseNameOf(preview.path)}
          {infoParts.length > 0 ? (
            <span className="binary-preview-info">
              {' '}
              · {infoParts.join(' · ')}
            </span>
          ) : null}
        </span>
        {preview.kind === 'image' || preview.kind === 'video' ? (
          <span
            className="binary-preview-zoom"
            role="toolbar"
            aria-label="확대"
          >
            <button
              type="button"
              className="format-btn"
              aria-label="축소"
              onClick={() => stepZoom(-1)}
            >
              −
            </button>
            <span className="binary-preview-zoom-value">
              {zoom === 'fit' ? '맞춤' : `${Math.round(zoom * 100)}%`}
            </span>
            <button
              type="button"
              className="format-btn"
              aria-label="확대"
              onClick={() => stepZoom(1)}
            >
              ＋
            </button>
            <button
              type="button"
              className="format-btn"
              aria-label="실제 크기"
              title="실제 크기 (100%)"
              onClick={() => setZoom(1)}
            >
              1:1
            </button>
            <button
              type="button"
              className="format-btn"
              aria-label="화면 맞춤"
              title="화면 맞춤"
              onClick={() => setZoom('fit')}
            >
              맞춤
            </button>
          </span>
        ) : null}
      </div>
      {preview.kind === 'image' ? (
        <div className="binary-preview-stage">
          <div
            className={`binary-preview-stage-inner${zoom === 'fit' ? ' fit' : ''}`}
          >
            <img
              className={`binary-preview-image${zoom === 'fit' ? ' fit' : ''}`}
              src={preview.url}
              alt={preview.path}
              style={
                zoom === 'fit' || !naturalSize
                  ? undefined
                  : { width: naturalSize.width * zoom }
              }
              onLoad={(event) => {
                const el = event.currentTarget;
                setNaturalSize({
                  width: el.naturalWidth,
                  height: el.naturalHeight,
                });
              }}
            />
          </div>
        </div>
      ) : preview.kind === 'video' ? (
        <div className="binary-preview-stage">
          <div
            className={`binary-preview-stage-inner${zoom === 'fit' ? ' fit' : ''}`}
          >
            <video
              className={`binary-preview-video${zoom === 'fit' ? ' fit' : ''}`}
              src={preview.url}
              controls
              style={
                zoom === 'fit' || !naturalSize
                  ? undefined
                  : { width: naturalSize.width * zoom }
              }
              onLoadedMetadata={(event) => {
                const el = event.currentTarget;
                setNaturalSize({
                  width: el.videoWidth,
                  height: el.videoHeight,
                });
              }}
              onError={() => setPlaybackFailed(true)}
            />
          </div>
        </div>
      ) : (
        <audio
          className="binary-preview-audio"
          src={preview.url}
          controls
          onError={() => setPlaybackFailed(true)}
        />
      )}
    </div>
  );
}
/* oxlint-enable jsx-a11y/media-has-caption */

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

function FormatButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="format-btn"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled ?? false}
      // textarea 선택이 풀리기 전에 처리 — click 대신 mousedown
      onMouseDown={(event) => {
        event.preventDefault();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}
