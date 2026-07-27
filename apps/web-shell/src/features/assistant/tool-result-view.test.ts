import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseToolResultView,
  readPtcToolActivityStatus,
} from './tool-result-view.js';

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

void test('PTC tool results distinguish resource admission from execution state', () => {
  const queuedOutput = JSON.stringify({
    kind: 'ptc_execute_code_cell_queued',
    status: 'queued',
    cellId: 'ptc_cell_queued',
  });
  const queuedView = parseToolResultView(
    toolResultContent({ tool: 'exec', ok: true, displayText: queuedOutput }),
  );
  assert.ok(queuedView);
  assert.equal(queuedView.ptcStatus, 'queued');
  assert.equal(queuedView.summary, 'PTC 리소스 대기 중');

  const resourceFailure = JSON.stringify({
    kind: 'ptc_execute_code_error',
    reasonCode: 'resource_budget_insufficient',
    message: 'resource budget is insufficient',
  });
  const rejectedView = parseToolResultView(
    toolResultContent({
      tool: 'exec',
      ok: false,
      displayText: 'resource budget is insufficient',
      output: JSON.stringify({
        ok: false,
        errorCode: 'execution_failed',
        error: 'resource budget is insufficient',
        details: JSON.parse(resourceFailure),
      }),
      errorCode: 'execution_failed',
      error: 'resource budget is insufficient',
    }),
  );
  assert.ok(rejectedView);
  assert.equal(rejectedView.ptcStatus, 'resource_budget_insufficient');
  assert.equal(rejectedView.summary, 'PTC 리소스 부족');

  assert.equal(
    readPtcToolActivityStatus({
      tool: 'exec',
      ok: false,
      text: resourceFailure,
    }),
    'resource_budget_insufficient',
  );
  assert.equal(
    readPtcToolActivityStatus({
      tool: 'read_file',
      ok: false,
      text: resourceFailure,
    }),
    undefined,
  );

  const completedWait = parseToolResultView(
    toolResultContent({
      tool: 'wait',
      ok: true,
      displayText: JSON.stringify({
        kind: 'ptc_execute_code_cell_wait',
        status: 'completed',
        cellId: 'ptc_cell_queued',
      }),
    }),
  );
  assert.equal(completedWait?.ptcStatus, 'completed');
  assert.equal(completedWait?.summary, 'PTC 실행 완료');
});

void test('PTC completed results expose durable artifact metadata without parsing file bytes', () => {
  const view = parseToolResultView(
    toolResultContent({
      tool: 'exec',
      ok: true,
      displayText: JSON.stringify({
        kind: 'ptc_execute_code_result',
        exitCode: 0,
        stdout: 'done',
        artifacts: {
          evidenceRef: 'sandbox-output:sandbox-evidence-1',
          files: [
            {
              relativePath: 'reports/summary.json',
              bytes: 42,
              sha256: 'a'.repeat(64),
            },
          ],
          totalBytes: 42,
        },
      }),
    }),
  );

  assert.deepEqual(view?.artifacts, {
    evidenceRef: 'sandbox-output:sandbox-evidence-1',
    files: [
      {
        relativePath: 'reports/summary.json',
        bytes: 42,
        sha256: 'a'.repeat(64),
      },
    ],
    totalBytes: 42,
  });
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
