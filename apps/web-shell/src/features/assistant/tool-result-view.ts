import {
  isPtcExecuteCodeArtifactExport,
  type PtcExecuteCodeArtifactExport,
} from '@geulbat/protocol/ptc-artifacts';

import { isRecord } from '../../lib/json.js';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';

export type PtcToolActivityStatus = NonNullable<
  Extract<RunTranscriptEntry, { kind: 'tool_activity' }>['ptcStatus']
>;

// tool_result 표시용 뷰모델 — raw JSON 블롭 대신 접힌 헤더(도구명 + 상태 +
// 한 줄 요약)와 펼침 본문(displayText/output, JSON이면 pretty print)으로
// 정리한다. 형식이 어긋나면 null을 돌려 기존 raw 렌더로 폴백한다.

export interface ToolResultView {
  tool: string;
  ok: boolean;
  // 접힌 헤더 우측 한 줄 — 실패면 에러 메시지, 성공이면 본문 첫 줄
  summary: string;
  ptcStatus?: PtcToolActivityStatus;
  artifacts?: PtcExecuteCodeArtifactExport;
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
  const ptcStatus = readPtcToolActivityStatus({
    tool: record.tool,
    ok: record.ok,
    text: record.ok ? displayText || output : output || displayText,
  });
  const artifacts = readPtcExecuteCodeArtifacts({
    tool: record.tool,
    ok: record.ok,
    text: displayText || output,
  });

  const summarySource =
    ptcStatus !== undefined
      ? formatPtcToolActivityStatus(ptcStatus)
      : record.ok
        ? (summarizeJsonPayload(displayText || output) ??
          allLines.find((line) => line.trim() !== '') ??
          '')
        : error || displayText || '실패';
  return {
    tool: record.tool,
    ok: record.ok,
    summary: truncateSummary(summarySource.trim()),
    ...(ptcStatus !== undefined ? { ptcStatus } : {}),
    ...(artifacts === undefined ? {} : { artifacts }),
    bodyLines,
    truncatedLineCount: allLines.length - bodyLines.length,
  };
}

function readPtcExecuteCodeArtifacts(args: {
  tool: string;
  ok: boolean;
  text: string;
}): PtcExecuteCodeArtifactExport | undefined {
  if (args.tool !== 'exec' || !args.ok || args.text.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.kind !== 'ptc_execute_code_result' ||
    !isPtcExecuteCodeArtifactExport(parsed.artifacts)
  ) {
    return undefined;
  }
  return {
    evidenceRef: parsed.artifacts.evidenceRef,
    files: parsed.artifacts.files.map((file) => ({ ...file })),
    totalBytes: parsed.artifacts.totalBytes,
  };
}

export function readPtcToolActivityStatus(args: {
  tool: string;
  ok: boolean;
  text: string;
  raw?: unknown;
}): PtcToolActivityStatus | undefined {
  if (args.tool !== 'exec' && args.tool !== 'wait') {
    return undefined;
  }

  let parsed = args.raw;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(args.text);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const result = !args.ok && isRecord(parsed.details) ? parsed.details : parsed;

  if (
    !args.ok &&
    (result.kind === 'ptc_execute_code_error' ||
      result.kind === 'ptc_execute_code_cell_wait_error') &&
    (result.reasonCode === 'resource_budget_unavailable' ||
      result.reasonCode === 'resource_budget_insufficient')
  ) {
    return result.reasonCode;
  }

  if (!args.ok) {
    return result.kind === 'ptc_execute_code_error' ||
      result.kind === 'ptc_execute_code_cell_wait_error'
      ? 'failed'
      : undefined;
  }
  if (args.tool === 'exec') {
    if (result.kind === 'ptc_execute_code_result') {
      return 'completed';
    }
    return (result.kind === 'ptc_execute_code_cell_queued' &&
      result.status === 'queued') ||
      (result.kind === 'ptc_execute_code_cell_running' &&
        result.status === 'running')
      ? result.status
      : undefined;
  }
  if (result.kind !== 'ptc_execute_code_cell_wait') {
    return undefined;
  }
  switch (result.status) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'terminated':
    case 'completed_with_cleanup_failure':
    case 'terminated_with_cleanup_failure':
    case 'missing':
    case 'expired':
      return result.status;
  }
  return undefined;
}

export function formatPtcToolActivityStatus(
  status: PtcToolActivityStatus,
): string {
  switch (status) {
    case 'queued':
      return 'PTC 리소스 대기 중';
    case 'running':
      return 'PTC 실행 중';
    case 'completed':
      return 'PTC 실행 완료';
    case 'failed':
      return 'PTC 실행 실패';
    case 'terminated':
      return 'PTC 실행 종료';
    case 'completed_with_cleanup_failure':
      return 'PTC 실행 완료 · 정리 실패';
    case 'terminated_with_cleanup_failure':
      return 'PTC 실행 종료 · 정리 실패';
    case 'missing':
      return 'PTC 실행 상태 없음';
    case 'expired':
      return 'PTC 실행 결과 만료';
    case 'resource_budget_unavailable':
      return 'PTC 리소스 상태 확인 불가';
    case 'resource_budget_insufficient':
      return 'PTC 리소스 부족';
  }
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
