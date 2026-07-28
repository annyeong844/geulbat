import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { brandRunId } from '../../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import {
  formatSubagentActivityMeta,
  RunTranscriptEntryBlock,
} from './assistant-transcript-entry-blocks.js';

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

  assert.match(approvalHtml, /승인 요청 · 파일 쓰기/u);
  assert.match(approvalHtml, /hello\.txt/u);

  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'explorer',
        state: 'completed',
        result: '정확한 원문',
        resultRef: 'subagent-result:delivery-report',
        resultDigest: `sha256:${'a'.repeat(64)}`,
        resultReport: {
          summary: '짧은 결과 보고',
          sourceResultRef: 'subagent-result:delivery-report',
          sourceResultDigest: `sha256:${'a'.repeat(64)}`,
        },
      }}
    />,
  );

  // 작가-facing 한 줄 요약 + expand (§3.3.2 #5)
  assert.match(subagentHtml, /explorer 작업 완료/);
  assert.match(subagentHtml, /결과 보고: 짧은 결과 보고/);
  assert.match(subagentHtml, /원문 결과: 정확한 원문/);
  assert.match(subagentHtml, /원문 결과 참조: subagent-result:delivery-report/);
  assert.match(subagentHtml, /<details/);
});

void test('ask_user selection reports its call identity and disables resubmission while sending', async () => {
  let resolveAnswer!: () => void;
  const pendingAnswer = new Promise<void>((resolve) => {
    resolveAnswer = resolve;
  });
  const answers: Array<{ answer: string; requestKey: string }> = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <RunTranscriptEntryBlock
        entry={{
          kind: 'tool_activity',
          tool: 'ask_user',
          state: 'running',
          callId: 'call-ask-user',
          args: {
            question: '어떻게 진행할까요?',
            options: [
              { label: '계속', description: '작업을 이어갑니다.' },
              { label: '중지', description: '여기서 멈춥니다.' },
            ],
          },
        }}
        onAskUserAnswer={(request) => {
          answers.push(request);
          return pendingAnswer;
        }}
      />,
    );
  });

  const option = renderer.root.findAllByProps({
    className: 'ask-user-option',
  })[0];
  assert.ok(option);
  act(() => {
    option.props.onClick();
  });

  assert.deepEqual(answers, [{ answer: '계속', requestKey: 'call-ask-user' }]);
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    1,
  );
  assert.equal(option.props.disabled, true);

  await act(async () => {
    resolveAnswer();
    await pendingAnswer;
    renderer.unmount();
  });
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
        capabilities: ['ptc'],
        toolSurface: 'explorer_ptc',
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

  // 접힌 요약줄은 제목과 경과 시간만 말한다. capability·도구 표면·토큰 누적을
  // 여기 옮겨 적으면 제목이 계측에 밀린다.
  const summaryHtml = subagentHtml.slice(
    subagentHtml.indexOf('<summary'),
    subagentHtml.indexOf('</summary>'),
  );
  assert.match(summaryHtml, /explorer 작업 완료/);
  assert.match(summaryHtml, /7m 55s/);
  assert.doesNotMatch(summaryHtml, /capability|도구:|런 누적/);

  // 펼친 본문이 계측의 정본이다.
  assert.match(subagentHtml, /도구: 읽기·검색 \+ PTC/);
  assert.match(subagentHtml, /capability: PTC/);
  assert.match(
    subagentHtml,
    /런 누적 · 총 입력 15.9k \(그중 캐시 900\) · 출력 1.2k/,
  );
  assert.match(
    subagentHtml,
    /토큰 \(런 누적\): 총 입력 15.9k · 그중 캐시 900 · 출력 1.2k/,
  );

  // 말할 시간이 없으면 자리 자체를 만들지 않는다.
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
  assert.doesNotMatch(bareHtml, /subagent-work-elapsed/);
});

void test('RunTranscriptEntryBlock renders durable live diagnostics and exact failure reason', () => {
  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'worker',
        state: 'failed',
        reason: 'tool_error',
        result: '부분 결과',
        resultRef: 'subagent-result:delivery-failed',
        runtime: {
          phase: 'tool_running',
          observedAt: '2026-07-23T09:58:12.345Z',
          lastTool: {
            name: 'shell_command',
            callId: 'call-shell-1',
            state: 'failed',
          },
          partialOutputAvailable: true,
          previousChildRunId: brandRunId('child-run-0'),
          providerRequest: {
            startedAt: '2026-07-23T09:57:00.000Z',
            lastEventAt: '2026-07-23T09:58:10.000Z',
            endedAt: '2026-07-23T09:58:12.345Z',
            durationMs: 72_345,
            attemptCount: 2,
            retry: {
              available: false,
              performed: true,
              outcome: 'exhausted',
            },
          },
        },
      }}
    />,
  );

  assert.match(subagentHtml, /진행: 도구 실행 중/);
  assert.match(subagentHtml, /관측: 2026-07-23T09:58:12.345Z/);
  assert.match(subagentHtml, /최근 도구: shell_command \(실패\)/);
  assert.match(subagentHtml, /부분 출력: 있음/);
  assert.match(subagentHtml, /부분 결과/);
  assert.match(subagentHtml, /결과 참조: subagent-result:delivery-failed/);
  assert.match(subagentHtml, /재시도 원본: child-run-0/);
  assert.match(subagentHtml, /종료 원인: 도구 오류/);
  assert.match(subagentHtml, /모델 요청 시작: 2026-07-23T09:57:00.000Z/);
  assert.match(subagentHtml, /마지막 제공자 이벤트: 2026-07-23T09:58:10.000Z/);
  assert.match(subagentHtml, /모델 요청 경과: 1m 12s/);
  assert.match(subagentHtml, /모델 요청 횟수: 2/);
  assert.match(subagentHtml, /자동 재시도: 불가 · 수행함 · 예산 소진/);
});

void test('RunTranscriptEntryBlock exposes terminal result retrieval waiting without reviving the child', () => {
  const pendingResultEntry = {
    kind: 'subagent_activity',
    childRunId: 'child-run-delivery-pending',
    subagentType: 'worker',
    state: 'completed',
    resultDeliveryState: 'pending',
    result: '완료된 결과',
  } as const;
  const html = renderToStaticMarkup(
    <RunTranscriptEntryBlock entry={pendingResultEntry} />,
  );

  assert.match(html, /worker 작업 완료 · 결과 회수 대기/);
  assert.match(html, /결과 전달: 부모 확인 대기/);
  assert.doesNotMatch(html, /중지/);
});

void test('formatSubagentActivityMeta derives active age from the exact observed timestamp', () => {
  const meta = formatSubagentActivityMeta(
    {
      kind: 'subagent_activity',
      childRunId: 'child-run-age',
      subagentType: 'explorer',
      state: 'spawned',
      runtime: {
        phase: 'provider_waiting',
        observedAt: '2026-07-23T11:00:00.000Z',
        partialOutputAvailable: false,
      },
    },
    Date.parse('2026-07-23T11:01:05.000Z'),
  );

  assert.match(meta ?? '', /관측: 2026-07-23T11:00:00.000Z/);
  assert.match(meta ?? '', /활동 경과: 1m 5s/);
});

void test('RunTranscriptEntryBlock distinguishes graceful daemon shutdown from restart recovery', () => {
  const shutdownHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-shutdown',
        subagentType: 'worker',
        state: 'cancelled',
        reason: 'daemon_shutdown',
      }}
    />,
  );

  assert.match(shutdownHtml, /종료 원인: 데몬 종료/);
  assert.doesNotMatch(shutdownHtml, /데몬 재시작/);
});

void test('RunTranscriptEntryBlock distinguishes a child rate-limit admission wait', () => {
  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'worker',
        state: 'spawned',
        runtime: {
          phase: 'rate_limit_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
          partialOutputAvailable: false,
        },
      }}
    />,
  );

  assert.match(subagentHtml, /진행: 요청 제한 해제 대기/);
});

void test('RunTranscriptEntryBlock distinguishes a child provider auth refresh wait', () => {
  const subagentHtml = renderToStaticMarkup(
    <RunTranscriptEntryBlock
      entry={{
        kind: 'subagent_activity',
        childRunId: 'child-run-1',
        subagentType: 'worker',
        state: 'spawned',
        runtime: {
          phase: 'auth_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
          partialOutputAvailable: false,
        },
      }}
    />,
  );

  assert.match(subagentHtml, /진행: 제공자 인증 갱신 대기/);
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

void test('RunTranscriptEntryBlock stops only a live child with parent identity', async () => {
  const requests: Array<{ parentRunId: string; childRunId: string }> = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RunTranscriptEntryBlock
        entry={{
          kind: 'subagent_activity',
          parentRunId: 'parent-run',
          childRunId: 'child-run',
          subagentType: 'explorer',
          state: 'spawned',
        }}
        onStopChildRun={async (request) => {
          requests.push(request);
        }}
      />,
    );
  });

  const stopButton = renderer.root
    .findAllByType('button')
    .find((button) => button.children.join('') === '중지');
  assert.ok(stopButton);
  await act(async () => {
    stopButton.props.onClick();
  });
  assert.deepEqual(requests, [
    { parentRunId: 'parent-run', childRunId: 'child-run' },
  ]);

  await act(async () => {
    renderer.update(
      <RunTranscriptEntryBlock
        entry={{
          kind: 'subagent_activity',
          parentRunId: 'parent-run',
          childRunId: 'child-run',
          subagentType: 'explorer',
          state: 'cancelled',
        }}
        onStopChildRun={() => {}}
      />,
    );
  });
  assert.equal(
    renderer.root
      .findAllByType('button')
      .some((button) => button.children.join('') === '중지'),
    false,
  );
  await act(async () => {
    renderer.unmount();
  });
});
