import { isRecord } from '@geulbat/protocol/runtime-utils';

import type { VisualizeWidgetView } from '../../artifacts/runtime-preview/visualize/document.js';

// visualize 도구 호출을 인라인 위젯 뷰로 좁힌다. 위젯 코드는 tool_result가
// 아니라 tool_call args에 실려 온다 — 결과 출력은 모델에 되돌아가는 확인
// 응답이라 작게 유지하고, 렌더 원본은 호출 인자가 정본이다.
export const VISUALIZE_TOOL_NAME = 'visualize';

export type { VisualizeWidgetView };

export function readVisualizeWidgetViewFromToolArgs(
  args: unknown,
): VisualizeWidgetView | null {
  if (!isRecord(args)) {
    return null;
  }
  const code = typeof args.code === 'string' ? args.code.trim() : '';
  if (code === '') {
    return null;
  }
  const title =
    typeof args.title === 'string' && args.title.trim() !== ''
      ? args.title.trim()
      : null;
  return {
    mode: detectVisualizeWidgetMode(code),
    code,
    title,
  };
}

// settled 트랜스크립트의 tool_call 메시지(content = JSON record)에서 위젯
// 뷰를 복원한다. visualize가 아니거나 형태가 어긋나면 null — 호출부는 기존
// 도구 행 렌더로 폴백한다.
export function readVisualizeWidgetViewFromToolCallContent(
  content: string,
): VisualizeWidgetView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.tool !== VISUALIZE_TOOL_NAME) {
    return null;
  }
  return readVisualizeWidgetViewFromToolArgs(parsed.args);
}

// 스트리밍 중인 tool_call 인자(JSON 텍스트 프리픽스)에서 code/title을
// 관용적으로 추출한다 — JSON이 아직 닫히지 않아도 "code" 문자열 값의
// 프리픽스를 디코드해 실시간 렌더 원본으로 쓴다.
export function readVisualizeStreamViewFromArgsText(
  argsText: string,
): VisualizeWidgetView | null {
  const code = readPartialJsonStringField(argsText, 'code');
  if (code === null || code.trim() === '') {
    return null;
  }
  const title = readPartialJsonStringField(argsText, 'title', {
    completeOnly: true,
  });
  return {
    mode: detectVisualizeWidgetMode(code),
    code,
    title: title !== null && title.trim() !== '' ? title.trim() : null,
  };
}

// JSON 텍스트에서 문자열 필드 값을 추출한다. 값이 아직 닫히지 않았으면
// completeOnly가 아닌 한 디코드된 프리픽스를 돌려준다.
function readPartialJsonStringField(
  text: string,
  field: string,
  options: { completeOnly?: boolean } = {},
): string | null {
  const keyToken = `"${field}"`;
  let searchFrom = 0;
  let keyIndex = -1;
  // 값 문자열 안에서 우연히 등장한 "code" 등을 피하려면 키 뒤에 콜론이
  // 따라오는 첫 위치를 찾는다 (visualize 인자 형태에선 충분히 안전).
  while (true) {
    const candidate = text.indexOf(keyToken, searchFrom);
    if (candidate === -1) {
      return null;
    }
    const afterKey = text.slice(candidate + keyToken.length);
    const colonMatch = /^\s*:/u.exec(afterKey);
    if (colonMatch) {
      keyIndex = candidate + keyToken.length + colonMatch[0].length;
      break;
    }
    searchFrom = candidate + keyToken.length;
  }
  const rest = text.slice(keyIndex);
  const openQuote = /^\s*"/u.exec(rest);
  if (!openQuote) {
    return null;
  }
  let decoded = '';
  let index = openQuote[0].length;
  while (index < rest.length) {
    const char = rest[index]!;
    if (char === '"') {
      return decoded;
    }
    if (char !== '\\') {
      decoded += char;
      index += 1;
      continue;
    }
    const escape = rest[index + 1];
    if (escape === undefined) {
      break;
    }
    if (escape === 'u') {
      const hex = rest.slice(index + 2, index + 6);
      if (hex.length < 4) {
        break;
      }
      const codePoint = Number.parseInt(hex, 16);
      if (Number.isNaN(codePoint)) {
        break;
      }
      decoded += String.fromCharCode(codePoint);
      index += 6;
      continue;
    }
    const simple: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const mapped = simple[escape];
    if (mapped === undefined) {
      break;
    }
    decoded += mapped;
    index += 2;
  }
  // 여기 도달 = 아직 닫히지 않은 값
  return options.completeOnly === true ? null : decoded;
}

export function detectVisualizeWidgetMode(code: string): 'svg' | 'html' {
  return code.trimStart().toLowerCase().startsWith('<svg') ? 'svg' : 'html';
}
