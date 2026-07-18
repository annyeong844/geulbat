import { isRecord } from '@geulbat/protocol/runtime-utils';

// CC식 diff 렌더용 뷰모델 — tool_call content(JSON)에서 파일 변경 도구의
// 변경 내용을 추출한다. 대상: apply_patch(V4A 패치 텍스트)와
// write_file(전체 덮어쓰기 → 전량 + 라인). 그 외 도구/형식 불일치는 null로
// 돌려 기존 raw JSON 렌더로 폴백한다.

export interface ToolDiffLine {
  type: 'hunk' | 'context' | 'add' | 'remove';
  text: string;
}

export interface ToolCallDiffView {
  tool: 'apply_patch' | 'write_file';
  path: string;
  action: '수정' | '새 파일' | '쓰기';
  lines: ToolDiffLine[];
  addedCount: number;
  removedCount: number;
  // 렌더 상한을 넘어 잘라낸 라인 수 (카운트는 전체 기준으로 이미 합산됨)
  truncatedLineCount: number;
}

// 거대 파일 쓰기가 대화창을 삼키지 않게 렌더만 자른다
const MAX_RENDERED_DIFF_LINES = 400;

export function parseToolCallDiff(content: string): ToolCallDiffView | null {
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
  const args = record.args;
  if (!isRecord(args)) {
    return null;
  }
  const argsRecord = args;
  if (record.tool === 'apply_patch' && typeof argsRecord.patch === 'string') {
    return parseApplyPatchDiff(argsRecord.patch);
  }
  if (
    record.tool === 'write_file' &&
    typeof argsRecord.path === 'string' &&
    typeof argsRecord.content === 'string'
  ) {
    return buildWriteFileDiff(argsRecord.path, argsRecord.content);
  }
  return null;
}

// V4A 패치 본문 파싱 — apply_patch는 파일 op을 정확히 1개만 허용하므로
// 첫 Add/Update File 섹션만 읽는다.
function parseApplyPatchDiff(patch: string): ToolCallDiffView | null {
  const rawLines = patch.split('\n');
  let path: string | null = null;
  let action: '수정' | '새 파일' | null = null;
  let start = -1;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!;
    if (line.startsWith('*** Update File: ')) {
      path = line.slice('*** Update File: '.length).trim();
      action = '수정';
      start = index + 1;
      break;
    }
    if (line.startsWith('*** Add File: ')) {
      path = line.slice('*** Add File: '.length).trim();
      action = '새 파일';
      start = index + 1;
      break;
    }
  }
  if (path === null || action === null || path === '') {
    return null;
  }

  const lines: ToolDiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;
  for (let index = start; index < rawLines.length; index += 1) {
    const line = rawLines[index]!;
    if (line.startsWith('***')) {
      break; // End Patch 또는 다음 파일 op
    }
    if (line.startsWith('@@')) {
      lines.push({ type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      addedCount += 1;
      lines.push({ type: 'add', text: line });
      continue;
    }
    if (line.startsWith('-')) {
      removedCount += 1;
      lines.push({ type: 'remove', text: line });
      continue;
    }
    // V4A의 컨텍스트 라인은 앞 공백 하나로 시작한다(빈 줄 포함)
    lines.push({ type: 'context', text: line });
  }
  if (lines.length === 0) {
    return null;
  }
  return truncateDiffLines({
    tool: 'apply_patch',
    path,
    action,
    lines,
    addedCount,
    removedCount,
    truncatedLineCount: 0,
  });
}

// write_file은 전체 덮어쓰기 — CC처럼 전량 + 라인으로 보여준다
function buildWriteFileDiff(path: string, content: string): ToolCallDiffView {
  const contentLines = content.split('\n');
  return truncateDiffLines({
    tool: 'write_file',
    path,
    action: '쓰기',
    lines: contentLines.map((text) => ({ type: 'add', text: `+${text}` })),
    addedCount: contentLines.length,
    removedCount: 0,
    truncatedLineCount: 0,
  });
}

function truncateDiffLines(view: ToolCallDiffView): ToolCallDiffView {
  if (view.lines.length <= MAX_RENDERED_DIFF_LINES) {
    return view;
  }
  return {
    ...view,
    lines: view.lines.slice(0, MAX_RENDERED_DIFF_LINES),
    truncatedLineCount: view.lines.length - MAX_RENDERED_DIFF_LINES,
  };
}
