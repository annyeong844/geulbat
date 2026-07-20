import { isRecord } from '../../lib/json.js';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';

// 도구 활동 타임라인 뷰모델 — 디자인개편 참조안의 "아이콘 행 + 세로
// 연결선 + 펼치면 Request/Response 카드" 표현을 위해, settled tool_call/
// tool_result 메시지 쌍과 라이브 tool_activity 엔트리를 하나의 행 모델로
// 접는다. 원본 content 문자열을 행에 실어 두고 실제 파싱(디프/결과 뷰)은
// 펼칠 때 기존 뷰모델(parseToolCallDiff/parseToolResultView)이 맡는다.

type ToolTimelineState = 'running' | 'completed' | 'failed';

export interface ToolTimelineItem {
  key: string;
  tool: string | null;
  label: string;
  state: ToolTimelineState;
  toolCallContent: string | null;
  toolResultContent: string | null;
}

const COMMAND_TOOL_NAMES = new Set(['exec_command', 'exec']);
const PLAN_TOOL_NAMES = new Set(['update_plan']);

// settled 스레드 메시지(도구 그룹 구간)를 callId로 짝지어 행으로 만든다.
// 결과가 callId 짝을 못 찾으면 같은 도구의 미결 행에, 그것도 없으면 독립
// 행으로 남긴다 — 어떤 메시지도 조용히 사라지지 않는다.
export function buildSettledToolTimelineItems(
  messages: ThreadMessage[],
  messageKeys: string[],
): ToolTimelineItem[] {
  const items: ToolTimelineItem[] = [];
  const openByCallId = new Map<string, ToolTimelineItem>();
  const openByTool = new Map<string, ToolTimelineItem[]>();

  const trackOpenItem = (
    item: ToolTimelineItem,
    callId: string | null,
  ): void => {
    if (callId !== null) {
      openByCallId.set(callId, item);
    }
    if (item.tool !== null) {
      const queue = openByTool.get(item.tool) ?? [];
      queue.push(item);
      openByTool.set(item.tool, queue);
    }
  };

  const takeOpenItem = (
    callId: string | null,
    tool: string | null,
  ): ToolTimelineItem | null => {
    if (callId !== null) {
      const matched = openByCallId.get(callId);
      if (matched) {
        openByCallId.delete(callId);
        if (matched.tool !== null) {
          const queue = openByTool.get(matched.tool) ?? [];
          openByTool.set(
            matched.tool,
            queue.filter((entry) => entry !== matched),
          );
        }
        return matched;
      }
    }
    if (tool !== null) {
      const queue = openByTool.get(tool) ?? [];
      const matched = queue.shift() ?? null;
      if (matched !== null) {
        openByTool.set(tool, queue);
      }
      return matched;
    }
    return null;
  };

  messages.forEach((message, index) => {
    const key = messageKeys[index] ?? message.entryId;
    const record = parseToolMessageRecord(message.content);
    const tool = record?.tool ?? null;
    const callId = record?.callId ?? null;

    if (message.role === 'tool_call') {
      const item: ToolTimelineItem = {
        key,
        tool,
        label: formatToolActivityLabel(tool ?? '도구'),
        state: 'completed',
        toolCallContent: message.content,
        toolResultContent: null,
      };
      items.push(item);
      trackOpenItem(item, callId);
      return;
    }

    if (message.role === 'tool_result') {
      const failed = record?.ok === false;
      const matched = takeOpenItem(callId, tool);
      if (matched !== null) {
        matched.toolResultContent = message.content;
        matched.state = failed ? 'failed' : 'completed';
        return;
      }
      items.push({
        key,
        tool,
        label: formatToolActivityLabel(tool ?? '도구'),
        state: failed ? 'failed' : 'completed',
        toolCallContent: null,
        toolResultContent: message.content,
      });
    }
  });

  return items;
}

// 라이브 tool_activity 엔트리를 행으로 접는다 — 같은 도구의 실행 중 행이
// 남아 있으면 완료/실패 엔트리가 그 행의 상태를 올린다 (라이브 이벤트에는
// callId가 없어 도구명 순서 매칭이 최선이다).
export function buildLiveToolTimelineItems(
  entries: Extract<RunTranscriptEntry, { kind: 'tool_activity' }>[],
): ToolTimelineItem[] {
  const items: ToolTimelineItem[] = [];
  const runningByTool = new Map<string, ToolTimelineItem[]>();

  entries.forEach((entry, index) => {
    if (entry.state === 'running') {
      const item: ToolTimelineItem = {
        key: `${entry.tool}:${index}`,
        tool: entry.tool,
        label: formatToolActivityLabel(entry.tool),
        state: 'running',
        toolCallContent: null,
        toolResultContent: null,
      };
      items.push(item);
      const queue = runningByTool.get(entry.tool) ?? [];
      queue.push(item);
      runningByTool.set(entry.tool, queue);
      return;
    }

    const queue = runningByTool.get(entry.tool) ?? [];
    const matched = queue.shift() ?? null;
    if (matched !== null) {
      runningByTool.set(entry.tool, queue);
      matched.state = entry.state;
      return;
    }
    items.push({
      key: `${entry.tool}:${index}`,
      tool: entry.tool,
      label: formatToolActivityLabel(entry.tool),
      state: entry.state,
      toolCallContent: null,
      toolResultContent: null,
    });
  });

  return items;
}

interface ToolGroupCallCounts {
  commandCount: number;
  toolCount: number;
}

export function isCommandToolName(tool: string | null): boolean {
  return tool !== null && COMMAND_TOOL_NAMES.has(tool);
}

// 접힌 그룹 헤더 — "명령 2개 실행함, 도구 3개 사용됨" 꼴. 한쪽이 0이면
// 그 조각은 생략한다.
export function summarizeToolGroupHeader(items: ToolTimelineItem[]): string {
  let commandCount = 0;
  let toolCount = 0;
  for (const item of items) {
    if (isCommandToolName(item.tool)) {
      commandCount += 1;
    } else {
      toolCount += 1;
    }
  }
  return summarizeToolGroupHeaderCounts({ commandCount, toolCount });
}

// settled 그룹은 접힌 상태에서 메시지 JSON을 파싱하지 않는다 — 그룹을
// 만들 때 경량 스캔으로 세어 둔 카운트만으로 헤더를 만든다.
export function summarizeToolGroupHeaderCounts(
  counts: ToolGroupCallCounts,
): string {
  const parts: string[] = [];
  if (counts.commandCount > 0) {
    parts.push(`명령 ${counts.commandCount}개 실행함`);
  }
  if (counts.toolCount > 0) {
    parts.push(`도구 ${counts.toolCount}개 사용됨`);
  }
  return parts.length > 0 ? parts.join(', ') : '도구를 사용함';
}

export function resolveToolTimelineGlyph(item: ToolTimelineItem): string {
  if (item.tool !== null && COMMAND_TOOL_NAMES.has(item.tool)) {
    return '❯';
  }
  if (item.tool !== null && PLAN_TOOL_NAMES.has(item.tool)) {
    return '☑';
  }
  return '✦';
}

export function formatToolActivityLabel(tool: string): string {
  if (tool.includes('code_map')) {
    return 'Code Map 사용함';
  }
  switch (tool) {
    case 'tool_search':
      return '도구 찾음';
    case 'read_file':
    case 'read_tool_output':
      return '파일 읽음';
    case 'list_files':
      return '파일 목록 봄';
    case 'search_files':
      return '파일 검색함';
    case 'exec_command':
    case 'exec':
      return '명령 실행함';
    case 'apply_patch':
      return '패치 적용함';
    case 'update_plan':
      return '할 일 업데이트됨';
    case 'agent_spawn':
      return '보조 작업 시작함';
    case 'agent_wait':
      return '보조 작업 기다림';
    default:
      return `${tool} 사용함`;
  }
}

// 펼친 카드의 Request 본문 — tool_call args를 사람이 읽게 펼친다.
export function readToolTimelineRequestBody(
  toolCallContent: string | null,
): string | null {
  if (toolCallContent === null) {
    return null;
  }
  const record = parseToolMessageRecord(toolCallContent);
  if (record === null || record.args === undefined) {
    return null;
  }
  try {
    return JSON.stringify(record.args, null, 2);
  } catch {
    return null;
  }
}

interface ToolMessageRecord {
  tool: string | null;
  callId: string | null;
  ok: boolean | null;
  args: unknown;
}

function parseToolMessageRecord(content: string): ToolMessageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    tool: typeof parsed.tool === 'string' ? parsed.tool : null,
    callId: typeof parsed.callId === 'string' ? parsed.callId : null,
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    args: parsed.args,
  };
}
