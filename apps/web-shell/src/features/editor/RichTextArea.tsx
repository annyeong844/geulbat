import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
} from 'react';

import { richHtmlToMarkdown, richMarkdownToHtml } from './rich-text-codec.js';

interface Props {
  value: string;
  readOnly: boolean;
  fontSize: number;
  lineHeight: number;
  className: string;
  placeholder: string;
  onChange: (value: string) => void;
}

export interface RichTextAreaHandle {
  emitChange(): void;
}

/**
 * 서식이 실제로 보이는 편집 영역 — contentEditable 위에서 브라우저
 * 네이티브 bold/italic/underline/색을 쓰고, 저장은 제한 markdown으로
 * 직렬화한다. 문서 모델 수준의 rich editor는 P8 owner.
 */
export const RichTextArea = forwardRef<RichTextAreaHandle, Props>(
  function RichTextArea(
    { value, readOnly, fontSize, lineHeight, className, placeholder, onChange },
    ref,
  ) {
    const editableRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedRef = useRef<string | null>(null);
    // 첫 렌더 HTML은 고정 — React가 이후 innerHTML을 되쓰지 않아
    // 입력 중 caret이 보존된다. 외부 값 변경은 effect가 반영.
    const initialHtmlRef = useRef<{ __html: string } | null>(null);
    if (initialHtmlRef.current === null) {
      initialHtmlRef.current = { __html: richMarkdownToHtml(value) };
      lastEmittedRef.current = value;
    }

    // 외부 값 변경(파일 전환/다시 불러오기)만 DOM에 반영 — 입력 중 되쓰기 금지
    useEffect(() => {
      const el = editableRef.current;
      if (!el || value === lastEmittedRef.current) {
        return;
      }
      lastEmittedRef.current = value;
      el.innerHTML = richMarkdownToHtml(value);
    }, [value]);

    const emitChange = useCallback(() => {
      const el = editableRef.current;
      if (!el) {
        return;
      }
      const markdown = richHtmlToMarkdown(el);
      lastEmittedRef.current = markdown;
      onChange(markdown);
    }, [onChange]);

    useImperativeHandle(ref, () => ({ emitChange }), [emitChange]);

    // 붙여넣기는 항상 plain text — 외부 HTML 유입 차단
    const handlePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    };

    return (
      <div
        ref={editableRef}
        className={`manuscript-editable ${className}`}
        style={{ fontSize, lineHeight }}
        contentEditable={!readOnly}
        role="textbox"
        aria-multiline="true"
        aria-label="본문"
        data-placeholder={placeholder}
        spellCheck={false}
        onInput={emitChange}
        onBlur={emitChange}
        onPaste={handlePaste}
        suppressContentEditableWarning
        dangerouslySetInnerHTML={initialHtmlRef.current}
      />
    );
  },
);
