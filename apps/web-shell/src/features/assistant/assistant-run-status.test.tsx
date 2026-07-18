import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  resolveRunStatusActivity,
  RunStatusRow,
} from './assistant-run-status.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('resolveRunStatusActivity names the tool while it is still running', () => {
  assert.equal(
    resolveRunStatusActivity([
      { kind: 'assistant_text', text: '먼저 설명' },
      { kind: 'tool_activity', tool: 'write_file', state: 'running' },
    ]),
    'write_file 실행 중',
  );

  // 마지막 활동이 끝났으면 모델 차례 — 기본 문구만
  assert.equal(
    resolveRunStatusActivity([
      { kind: 'tool_activity', tool: 'write_file', state: 'completed' },
    ]),
    null,
  );

  assert.equal(
    resolveRunStatusActivity([
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'explorer',
        state: 'spawned',
      },
    ]),
    '보조 작업 진행 중',
  );

  assert.equal(resolveRunStatusActivity([]), null);
});

void test('RunStatusRow appends run usage totals when provided', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RunStatusRow
        transcriptEntries={[]}
        usageTotals={{
          inputTokens: 9800,
          outputTokens: 252,
          cachedInputTokens: 4000,
        }}
      />,
    );
  });

  assert.match(
    JSON.stringify(renderer.toJSON()),
    /런 누적 · 총 입력 9.8k \(그중 캐시 4k\) · 출력 252/,
  );

  await act(async () => {
    renderer.unmount();
  });

  // usage가 없으면 토큰 표기도 없다
  let withoutUsage!: ReactTestRenderer;
  await act(async () => {
    withoutUsage = TestRenderer.create(<RunStatusRow transcriptEntries={[]} />);
  });
  assert.doesNotMatch(JSON.stringify(withoutUsage.toJSON()), /토큰/);
  await act(async () => {
    withoutUsage.unmount();
  });
});

void test('RunStatusRow renders a live working indicator with elapsed time', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RunStatusRow
        transcriptEntries={[
          { kind: 'tool_activity', tool: 'read_file', state: 'running' },
        ]}
      />,
    );
  });

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /✻/);
  assert.match(rendered, /생각 중/);
  assert.match(rendered, /… \(/u);
  assert.match(rendered, /read_file 실행 중/);
  // 방금 시작 — 1초 미만 표기
  assert.match(rendered, /<1s/);

  await act(async () => {
    renderer.unmount();
  });
});
