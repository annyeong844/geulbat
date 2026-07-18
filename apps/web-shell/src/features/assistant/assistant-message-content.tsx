import { memo, useEffect, useRef, useState } from 'react';
import {
  ARTIFACT_END_MARKER,
  ARTIFACT_START_PREFIX,
} from '@geulbat/protocol/artifacts';

import { buildMarkdownBlocks } from '../../lib/markdown/buildMarkdownBlocks.js';
import { assistantStyles } from './assistant-styles.js';

type MessageContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; language: string | null; code: string };

// ``` 펜스 기준으로 답변 본문을 텍스트/코드 구간으로 나눈다.
// 닫는 펜스가 없으면(스트리밍 중 등) 나머지 전체를 코드로 취급한다.
export function splitMessageContentSegments(
  content: string,
): MessageContentSegment[] {
  const segments: MessageContentSegment[] = [];
  const lines = content.split('\n');
  let textBuffer: string[] = [];
  let codeBuffer: string[] | null = null;
  let codeLanguage: string | null = null;

  const flushText = () => {
    if (textBuffer.length > 0) {
      segments.push({ kind: 'text', text: textBuffer.join('\n') });
      textBuffer = [];
    }
  };

  for (const line of lines) {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence && codeBuffer === null) {
      flushText();
      codeBuffer = [];
      codeLanguage = fence[1] ? fence[1] : null;
      continue;
    }
    if (fence && codeBuffer !== null) {
      segments.push({
        kind: 'code',
        language: codeLanguage,
        code: codeBuffer.join('\n'),
      });
      codeBuffer = null;
      codeLanguage = null;
      continue;
    }
    if (codeBuffer !== null) {
      codeBuffer.push(line);
    } else {
      textBuffer.push(line);
    }
  }
  if (codeBuffer !== null) {
    segments.push({
      kind: 'code',
      language: codeLanguage,
      code: codeBuffer.join('\n'),
    });
  } else {
    flushText();
  }
  return segments;
}

// 복사 성공 시 잠깐 '복사됨' 상태를 유지하는 공용 훅 — 메시지/코드블록
// 복사 버튼이 같은 동작을 공유한다.
export function useCopyToClipboard(): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (resetTimer.current !== null) {
          clearTimeout(resetTimer.current);
        }
        resetTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return { copied, copy };
}

function MessageCodeBlock(props: { language: string | null; code: string }) {
  const { language, code } = props;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="message-code-block">
      <div className="message-code-block-header">
        <span className="message-code-block-language">{language ?? ''}</span>
        <button
          type="button"
          className="message-code-copy-button"
          title="코드 복사"
          aria-label="코드 복사"
          onClick={() => copy(code)}
        >
          {copied ? '✓ 복사됨' : '⧉'}
        </button>
      </div>
      <pre className="message-code-block-body">{code}</pre>
    </div>
  );
}

// 답변 본문 렌더 — 텍스트는 공용 Markdown, 코드 펜스는 복사 가능한 블록.
export const AssistantMessageContent = memo(
  function AssistantMessageContent(props: { content: string }) {
    if (
      props.content.includes(ARTIFACT_START_PREFIX) ||
      props.content.includes(ARTIFACT_END_MARKER)
    ) {
      return <pre style={assistantStyles.messageText}>{props.content}</pre>;
    }

    const segments = splitMessageContentSegments(props.content);
    return (
      <>
        {segments.map((segment, index) =>
          segment.kind === 'code' ? (
            <MessageCodeBlock
              key={`code-${index}`}
              language={segment.language}
              code={segment.code}
            />
          ) : (
            <div key={`text-${index}`} className="message-markdown">
              {buildMarkdownBlocks(segment.text)}
            </div>
          ),
        )}
      </>
    );
  },
);
