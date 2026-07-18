import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import type { RichTextAreaHandle } from './RichTextArea.js';

// 한글(HWP) 크기 목록과 유사한 프리셋
const FONT_SIZE_PRESETS = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 72,
] as const;

const LINE_SPACING_PRESETS = [100, 115, 130, 145, 160, 180, 200] as const;

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

type RichFormatToolbarController = ReturnType<typeof useRichFormatToolbar>;

// 리치 포맷팅 상태·커맨드 소유자 — Editor는 이 훅을 호출해 lineSpacing을
// 본문 렌더에 쓰고, 나머지는 FormatToolbar에 controller로 넘긴다.
export function useRichFormatToolbar(args: {
  readOnly: boolean;
  richTextAreaRef: RefObject<RichTextAreaHandle | null>;
}) {
  const { readOnly, richTextAreaRef } = args;

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
    [readOnly, richTextAreaRef],
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
    [readOnly, richTextAreaRef],
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
    [readOnly, richTextAreaRef],
  );
  const stepFontSize = useCallback(
    (delta: number) => {
      applySelectionFontSize(selectionFontSize + delta);
    },
    [applySelectionFontSize, selectionFontSize],
  );

  return {
    readOnly,
    runRichCommand,
    textColor,
    applyTextColor,
    toolbarMenu,
    setToolbarMenu,
    lineSpacing,
    setLineSpacing,
    selectionFontSize,
    setSelectionFontSize,
    rememberEditableSelection,
    applySelectionFontSize,
    stepFontSize,
  };
}

export function FormatToolbar({
  controller,
  isDirty,
  saving,
  onSave,
}: {
  controller: RichFormatToolbarController;
  isDirty: boolean;
  saving: boolean;
  onSave: () => Promise<void> | void;
}) {
  const {
    readOnly,
    runRichCommand,
    textColor,
    applyTextColor,
    toolbarMenu,
    setToolbarMenu,
    lineSpacing,
    setLineSpacing,
    selectionFontSize,
    setSelectionFontSize,
    rememberEditableSelection,
    applySelectionFontSize,
    stepFontSize,
  } = controller;
  return (
    <div className="format-toolbar" role="toolbar" aria-label="서식">
      <span className="font-size-control" title="글자 크기 — 선택 영역에 적용">
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
            setToolbarMenu((prev) => (prev === 'fontsize' ? null : 'fontsize'));
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
  );
}

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
