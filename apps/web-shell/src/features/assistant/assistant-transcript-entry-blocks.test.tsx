import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('RunTranscriptEntryBlock renders run transcript leaf entries', () => {
  const assistantTextHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{ kind: 'assistant_text', text: 'Thinking...' }}
    />,
  );

  assert.match(assistantTextHtml, /Thinking/);

  const approvalHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'approval_request',
        pendingApproval: makeApprovalRequiredFixture({
          argumentsPreview: { path: 'hello.txt', content: 'Hello' },
        }),
      }}
    />,
  );

  assert.match(approvalHtml, /Write hello.txt/);

  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'explorer',
        state: 'completed',
        result: 'summary',
      }}
    />,
  );

  // 작가-facing 한 줄 요약 + expand (§3.3.2 #5)
  assert.match(subagentHtml, /explorer 작업 완료/);
  assert.match(subagentHtml, /summary/);
  assert.match(subagentHtml, /<details/);
});

void test('RunTranscriptEntryBlock defers a live visualize iframe without dropping its layout shell', () => {
  const markup = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'tool_activity',
        tool: 'visualize',
        state: 'running',
        argsText: JSON.stringify({
          code: '<svg viewBox="0 0 10 10"><circle r="4" /></svg>',
          title: 'Live visualization',
        }),
      }}
      deferVisualizeRuntimeBoot
    />,
  );

  assert.match(markup, /visualize-widget/);
  assert.doesNotMatch(markup, /<iframe/);
});

void test('RunTranscriptEntryBlock keeps a live visualize iframe mounted during later scroll deferral', async () => {
  const entry = {
    kind: 'tool_activity' as const,
    tool: 'visualize',
    state: 'running' as const,
    argsText: JSON.stringify({
      code: '<svg viewBox="0 0 10 10"><circle r="4" /></svg>',
      title: 'Live visualization',
    }),
  };
  const partialEntry = {
    ...entry,
    argsText: '{"code":',
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RunTranscriptEntryBlock entry={partialEntry} />,
    );
  });
  assert.equal(renderer.root.findAllByType('iframe').length, 0);

  await act(async () => {
    renderer.update(
      <RunTranscriptEntryBlock entry={entry} deferVisualizeRuntimeBoot />,
    );
  });
  assert.equal(renderer.root.findAllByType('iframe').length, 0);

  await act(async () => {
    renderer.update(<RunTranscriptEntryBlock entry={entry} />);
  });
  const mountedFrame = renderer.root.findByType('iframe');

  await act(async () => {
    renderer.update(
      <RunTranscriptEntryBlock entry={entry} deferVisualizeRuntimeBoot />,
    );
  });
  assert.equal(renderer.root.findByType('iframe'), mountedFrame);

  await act(async () => {
    renderer.unmount();
  });
});

void test('RunTranscriptEntryBlock renders subagent terminal telemetry as CC-style meta', () => {
  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'explorer',
        state: 'completed',
        result: 'summary',
        elapsedMs: 475_000,
        usage: {
          inputTokens: 15_900,
          outputTokens: 1_200,
          cachedInputTokens: 900,
        },
      }}
    />,
  );

  assert.match(subagentHtml, /7m 55s/);
  assert.match(
    subagentHtml,
    /런 누적 · 총 입력 15.9k \(그중 캐시 900\) · 출력 1.2k/,
  );
  assert.match(
    subagentHtml,
    /토큰 \(런 누적\): 총 입력 15.9k · 그중 캐시 900 · 출력 1.2k/,
  );

  // Telemetry-free entries keep the bare title (no empty parentheses).
  const bareHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-2',
        subagentType: 'worker',
        state: 'spawned',
      }}
    />,
  );
  assert.doesNotMatch(bareHtml, /\(/);
});

void test('RunTranscriptEntryBlock offers child session drill-down only when identity and handler exist', () => {
  const withDrilldown = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        childThreadId: '00000000-0000-4000-8000-000000000777',
        subagentType: 'explorer',
        state: 'completed',
      }}
      onOpenChildSession={() => {}}
    />,
  );
  assert.match(withDrilldown, /트랜스크립트 보기/);

  const withoutThreadId = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'explorer',
        state: 'completed',
      }}
      onOpenChildSession={() => {}}
    />,
  );
  assert.doesNotMatch(withoutThreadId, /트랜스크립트 보기/);

  const withoutHandler = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        childThreadId: '00000000-0000-4000-8000-000000000777',
        subagentType: 'explorer',
        state: 'completed',
      }}
    />,
  );
  assert.doesNotMatch(withoutHandler, /트랜스크립트 보기/);
});
