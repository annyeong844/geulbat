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
  assert.deepEqual(
    resolveRunStatusActivity([
      { kind: 'assistant_text', text: '먼저 설명' },
      { kind: 'tool_activity', tool: 'write_file', state: 'running' },
    ]),
    { kind: 'tool', label: 'write_file' },
  );

  // 마지막 활동이 끝났으면 모델 차례 — 기본 문구만
  assert.equal(
    resolveRunStatusActivity([
      { kind: 'tool_activity', tool: 'write_file', state: 'completed' },
    ]),
    null,
  );

  assert.deepEqual(
    resolveRunStatusActivity([
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'explorer',
        state: 'spawned',
      },
    ]),
    { kind: 'context', label: '보조 작업 진행 중' },
  );

  assert.equal(resolveRunStatusActivity([]), null);
});

void test('resolveRunStatusActivity exposes provider admission waits without hiding active tools', () => {
  const rateLimitWait = {
    phase: 'rate_limit_waiting' as const,
    observedAt: '2026-07-23T11:00:00.000Z',
  };

  assert.deepEqual(resolveRunStatusActivity([], rateLimitWait), {
    kind: 'context',
    label: '요청 제한 해제 대기',
  });
  assert.deepEqual(
    resolveRunStatusActivity([], {
      phase: 'auth_waiting',
      observedAt: '2026-07-23T11:00:00.500Z',
    }),
    { kind: 'context', label: '제공자 인증 갱신 대기' },
  );
  assert.deepEqual(
    resolveRunStatusActivity([], {
      phase: 'provider_waiting',
      observedAt: '2026-07-23T11:00:01.000Z',
    }),
    { kind: 'context', label: '모델 응답 대기' },
  );
  assert.deepEqual(
    resolveRunStatusActivity([], {
      phase: 'provider_streaming',
      observedAt: '2026-07-23T11:00:01.500Z',
    }),
    { kind: 'context', label: '응답 생성 중' },
  );
  assert.deepEqual(
    resolveRunStatusActivity(
      [{ kind: 'tool_activity', tool: 'read_file', state: 'running' }],
      rateLimitWait,
    ),
    { kind: 'tool', label: 'read_file' },
  );
});

void test('RunStatusRow renders the provider auth refresh wait beside the existing cancelable run UI', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RunStatusRow
        transcriptEntries={[]}
        providerRuntime={{
          phase: 'auth_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
        }}
      />,
    );
  });

  assert.match(JSON.stringify(renderer.toJSON()), /제공자 인증 갱신 대기/);
  assert.match(JSON.stringify(renderer.toJSON()), /활동 경과/);
  assert.equal(
    renderer.root.findAllByProps({ className: 'run-status-active-tool' })
      .length,
    0,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('RunStatusRow renders the rate-limit wait beside the existing cancelable run UI', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RunStatusRow
        transcriptEntries={[]}
        providerRuntime={{
          phase: 'rate_limit_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
        }}
      />,
    );
  });

  assert.match(JSON.stringify(renderer.toJSON()), /요청 제한 해제 대기/);

  await act(async () => {
    renderer.unmount();
  });
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
  assert.match(rendered, /run-status-row--tool-active/);
  // 방금 시작 — 1초 미만 표기
  assert.match(rendered, /<1s/);
  const activeTool = renderer.root.findByProps({
    className: 'run-status-active-tool',
  });
  assert.equal(activeTool.props['aria-label'], 'read_file 실행 중');
  assert.equal(
    activeTool.findByProps({ className: 'run-status-active-tool-name' })
      .children[0],
    'read_file',
  );
  assert.doesNotMatch(
    renderer.root.findByProps({ className: 'run-status-meta' })
      .children[0] as string,
    /read_file/u,
  );

  await act(async () => {
    renderer.unmount();
  });
});
