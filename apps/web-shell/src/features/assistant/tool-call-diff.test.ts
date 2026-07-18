import test from 'node:test';
import assert from 'node:assert/strict';

import { parseToolCallDiff } from './tool-call-diff.js';

function toolCallContent(tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ id: 'fc-1', callId: 'call-1', tool, args });
}

void test('parseToolCallDiff parses an apply_patch update into typed diff lines', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '@@ function main()',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
    '*** End Patch',
  ].join('\n');

  const diff = parseToolCallDiff(toolCallContent('apply_patch', { patch }));
  assert.ok(diff);
  assert.equal(diff.tool, 'apply_patch');
  assert.equal(diff.path, 'src/app.ts');
  assert.equal(diff.action, '수정');
  assert.equal(diff.addedCount, 2);
  assert.equal(diff.removedCount, 1);
  assert.equal(diff.truncatedLineCount, 0);
  assert.deepEqual(
    diff.lines.map((line) => line.type),
    ['hunk', 'context', 'remove', 'add', 'add', 'context'],
  );
});

void test('parseToolCallDiff treats Add File sections as new files', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: docs/note.md',
    '+# 제목',
    '+본문',
    '*** End Patch',
  ].join('\n');

  const diff = parseToolCallDiff(toolCallContent('apply_patch', { patch }));
  assert.ok(diff);
  assert.equal(diff.action, '새 파일');
  assert.equal(diff.addedCount, 2);
  assert.equal(diff.removedCount, 0);
});

void test('parseToolCallDiff renders write_file content as all-added lines', () => {
  const diff = parseToolCallDiff(
    toolCallContent('write_file', {
      path: 'notes/hello.txt',
      content: '첫 줄\n둘째 줄',
    }),
  );
  assert.ok(diff);
  assert.equal(diff.tool, 'write_file');
  assert.equal(diff.action, '쓰기');
  assert.equal(diff.addedCount, 2);
  assert.deepEqual(
    diff.lines.map((line) => line.text),
    ['+첫 줄', '+둘째 줄'],
  );
});

void test('parseToolCallDiff truncates oversized diffs but keeps full counts', () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join(
    '\n',
  );
  const diff = parseToolCallDiff(
    toolCallContent('write_file', { path: 'big.txt', content }),
  );
  assert.ok(diff);
  assert.equal(diff.addedCount, 1000);
  assert.equal(diff.lines.length, 400);
  assert.equal(diff.truncatedLineCount, 600);
});

void test('parseToolCallDiff returns null for non-diff tools and malformed content', () => {
  assert.equal(
    parseToolCallDiff(toolCallContent('exec_command', { command: 'ls' })),
    null,
  );
  assert.equal(parseToolCallDiff('not json'), null);
  assert.equal(
    parseToolCallDiff(
      toolCallContent('apply_patch', { patch: '엉뚱한 텍스트' }),
    ),
    null,
  );
  // 경로 없는 Update 지시문 — 폴백
  assert.equal(
    parseToolCallDiff(
      toolCallContent('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: \n+x\n*** End Patch',
      }),
    ),
    null,
  );
});
