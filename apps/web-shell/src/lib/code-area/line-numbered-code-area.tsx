import { useMemo, useRef } from 'react';

// 줄 번호 거터 + 줄 밑줄이 있는 고정폭 코드 영역 — 편집기 코드 뷰어(파일)와
// 아티팩트 원문 보기(</> 모드)가 공유한다. onChange가 없으면 읽기 전용.
// 줄 밑줄은 line-height에 맞춘 반복 그라디언트로, background-attachment:
// local이라 스크롤을 따라간다 (CSS는 .code-area 계열 클래스가 소유).
export function LineNumberedCodeArea(props: {
  value: string;
  ariaLabel: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const { value, ariaLabel, onChange, readOnly = false, placeholder } = props;
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = useMemo(
    () => Math.max(1, value.split('\n').length),
    [value],
  );

  return (
    <div className="code-area">
      <div className="code-area-gutter" ref={gutterRef} aria-hidden>
        {Array.from({ length: lineCount }, (_, index) => (
          <span key={index} className="code-area-line-number">
            {index + 1}
          </span>
        ))}
      </div>
      <textarea
        className="code-area-input"
        value={value}
        wrap="off"
        spellCheck={false}
        aria-label={ariaLabel}
        readOnly={readOnly || onChange === undefined}
        {...(placeholder !== undefined ? { placeholder } : {})}
        onChange={(event) => onChange?.(event.target.value)}
        onScroll={(event) => {
          if (gutterRef.current) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }
        }}
      />
    </div>
  );
}
