import { isRecord } from '../../lib/json.js';

// tool_result 표시용 뷰모델 — raw JSON 블롭 대신 접힌 헤더(도구명 + 상태 +
// 한 줄 요약)와 펼침 본문(displayText/output, JSON이면 pretty print)으로
// 정리한다. 형식이 어긋나면 null을 돌려 기존 raw 렌더로 폴백한다.

export interface ToolResultView {
  tool: string;
  ok: boolean;
  // 접힌 헤더 우측 한 줄 — 실패면 에러 메시지, 성공이면 본문 첫 줄
  summary: string;
  bodyLines: string[];
  truncatedLineCount: number;
}

const MAX_RENDERED_RESULT_LINES = 400;
const MAX_SUMMARY_LENGTH = 80;

export function parseToolResultView(content: string): ToolResultView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const record = parsed;
  if (typeof record.tool !== 'string' || typeof record.ok !== 'boolean') {
    return null;
  }
  const displayText =
    typeof record.displayText === 'string' ? record.displayText : '';
  const output = typeof record.output === 'string' ? record.output : '';
  const error = typeof record.error === 'string' ? record.error : '';

  const body = prettyPrintIfJson(displayText || output);
  const allLines = body === '' ? [] : body.split('\n');
  const bodyLines = allLines.slice(0, MAX_RENDERED_RESULT_LINES);

  const summarySource = record.ok
    ? (summarizeJsonPayload(displayText || output) ??
      allLines.find((line) => line.trim() !== '') ??
      '')
    : error || displayText || '실패';
  return {
    tool: record.tool,
    ok: record.ok,
    summary: truncateSummary(summarySource.trim()),
    bodyLines,
    truncatedLineCount: allLines.length - bodyLines.length,
  };
}

// displayText가 JSON 문자열인 도구가 많다(list_files, write_file 등) —
// 사람이 읽게 들여쓰기로 펼친다. JSON이 아니면 원문 그대로.
function prettyPrintIfJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

// JSON 결과의 요약이 "{"가 되지 않게 — 대표 필드(path)가 있으면 그걸 쓴다
function summarizeJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) &&
      typeof parsed.path === 'string' &&
      parsed.path !== ''
      ? parsed.path
      : null;
  } catch {
    return null;
  }
}

function truncateSummary(line: string): string {
  if (line.length <= MAX_SUMMARY_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_SUMMARY_LENGTH)}…`;
}
