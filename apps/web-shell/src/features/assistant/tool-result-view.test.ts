import test from 'node:test';
import assert from 'node:assert/strict';

import { parseToolResultView } from './tool-result-view.js';

function toolResultContent(fields: Record<string, unknown>): string {
  return JSON.stringify({
    callId: 'call-1',
    computerFilesMayHaveChanged: false,
    ...fields,
  });
}

void test('parseToolResultView pretty-prints JSON displayText and summarizes the first line', () => {
  const view = parseToolResultView(
    toolResultContent({
      tool: 'list_files',
      ok: true,
      displayText: JSON.stringify({ path: '.', total: 2 }),
    }),
  );
  assert.ok(view);
  assert.equal(view.tool, 'list_files');
  assert.equal(view.ok, true);
  assert.equal(view.bodyLines[0], '{');
  assert.match(view.bodyLines.join('\n'), /"path": "\."/);
  // JSON 결과 요약은 "{" 대신 대표 필드(path)
  assert.equal(view.summary, '.');
  assert.equal(view.truncatedLineCount, 0);
});

void test('parseToolResultView keeps plain text output as-is', () => {
  const view = parseToolResultView(
    toolResultContent({
      tool: 'exec_command',
      ok: true,
      displayText: 'hello\nworld',
    }),
  );
  assert.ok(view);
  assert.deepEqual(view.bodyLines, ['hello', 'world']);
  assert.equal(view.summary, 'hello');
});

void test('parseToolResultView surfaces the error message for failures', () => {
  const view = parseToolResultView(
    toolResultContent({
      tool: 'read_file',
      ok: false,
      displayText: 'computer session root is unavailable',
      output: '',
      errorCode: 'access_denied',
      error: 'computer session root is unavailable',
    }),
  );
  assert.ok(view);
  assert.equal(view.ok, false);
  assert.equal(view.summary, 'computer session root is unavailable');
});

void test('parseToolResultView truncates long bodies and falls back on malformed content', () => {
  const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
  const view = parseToolResultView(
    toolResultContent({ tool: 'exec_command', ok: true, displayText: long }),
  );
  assert.ok(view);
  assert.equal(view.bodyLines.length, 400);
  assert.equal(view.truncatedLineCount, 500);

  assert.equal(parseToolResultView('not json'), null);
  assert.equal(
    parseToolResultView(JSON.stringify({ ok: true })), // tool 없음
    null,
  );
});
