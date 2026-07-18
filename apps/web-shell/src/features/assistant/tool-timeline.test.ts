import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import {
  buildLiveToolTimelineItems,
  buildSettledToolTimelineItems,
  formatToolActivityLabel,
  readToolTimelineRequestBody,
  summarizeToolGroupHeader,
} from './tool-timeline.js';

function toolMessage(
  role: 'tool_call' | 'tool_result',
  record: Record<string, unknown>,
  entryId: string,
): ThreadMessage {
  return {
    entryId,
    role,
    content: JSON.stringify(record),
    timestamp: '2026-07-17T00:00:00.000Z',
  } as ThreadMessage;
}

void test('settled tool_call/tool_result 쌍은 callId로 한 행에 접힌다', () => {
  const items = buildSettledToolTimelineItems(
    [
      toolMessage(
        'tool_call',
        { callId: 'c1', tool: 'read_file', args: { path: 'a.ts' } },
        'e1',
      ),
      toolMessage(
        'tool_result',
        { callId: 'c1', tool: 'read_file', ok: true, output: '{"ok":true}' },
        'e2',
      ),
    ],
    ['k1', 'k2'],
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]!.tool, 'read_file');
  assert.equal(items[0]!.label, '파일 읽음');
  assert.equal(items[0]!.state, 'completed');
  assert.notEqual(items[0]!.toolCallContent, null);
  assert.notEqual(items[0]!.toolResultContent, null);
});

void test('실패한 결과는 행 상태를 failed로 올리고, 짝 없는 결과도 행으로 남는다', () => {
  const items = buildSettledToolTimelineItems(
    [
      toolMessage(
        'tool_call',
        { callId: 'c1', tool: 'exec_command', args: { command: 'ls' } },
        'e1',
      ),
      toolMessage(
        'tool_result',
        { callId: 'c1', tool: 'exec_command', ok: false, error: 'boom' },
        'e2',
      ),
      toolMessage(
        'tool_result',
        { callId: 'c9', tool: 'search_files', ok: true, output: 'hits' },
        'e3',
      ),
    ],
    ['k1', 'k2', 'k3'],
  );

  assert.equal(items.length, 2);
  assert.equal(items[0]!.state, 'failed');
  assert.equal(items[1]!.tool, 'search_files');
  assert.equal(items[1]!.toolCallContent, null);
});

void test('라이브 엔트리는 같은 도구의 실행 중 행을 완료 상태로 올린다', () => {
  const items = buildLiveToolTimelineItems([
    { kind: 'tool_activity', tool: 'read_file', state: 'running' },
    { kind: 'tool_activity', tool: 'update_plan', state: 'running' },
    { kind: 'tool_activity', tool: 'read_file', state: 'completed' },
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0]!.tool, 'read_file');
  assert.equal(items[0]!.state, 'completed');
  assert.equal(items[1]!.tool, 'update_plan');
  assert.equal(items[1]!.state, 'running');
});

void test('그룹 헤더는 명령/도구 수를 나눠 말한다', () => {
  const items = buildLiveToolTimelineItems([
    { kind: 'tool_activity', tool: 'exec_command', state: 'completed' },
    { kind: 'tool_activity', tool: 'exec_command', state: 'completed' },
    { kind: 'tool_activity', tool: 'read_file', state: 'completed' },
  ]);
  assert.equal(
    summarizeToolGroupHeader(items),
    '명령 2개 실행함, 도구 1개 사용됨',
  );
  assert.equal(summarizeToolGroupHeader([]), '도구를 사용함');
});

void test('Request 본문은 tool_call args를 펼쳐 보여준다', () => {
  const content = JSON.stringify({
    callId: 'c1',
    tool: 'read_file',
    args: { path: 'a.ts' },
  });
  assert.equal(
    readToolTimelineRequestBody(content),
    JSON.stringify({ path: 'a.ts' }, null, 2),
  );
  assert.equal(readToolTimelineRequestBody(null), null);
  assert.equal(readToolTimelineRequestBody('not json'), null);
});

void test('도구 라벨은 사람 말로 바뀐다', () => {
  assert.equal(formatToolActivityLabel('update_plan'), '할 일 업데이트됨');
  assert.equal(formatToolActivityLabel('tool_search'), '도구 찾음');
  assert.equal(formatToolActivityLabel('unknown_tool'), 'unknown_tool 사용함');
});
