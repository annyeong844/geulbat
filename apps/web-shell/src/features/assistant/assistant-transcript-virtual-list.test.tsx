import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import type { ThreadMessage } from '@geulbat/protocol/threads';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { createAssistantProps } from '../../test-support/create-assistant-props.js';
import { toolMessage } from '../../test-support/transcript-message-fixtures.js';
import {
  extractTranscriptVirtualRange,
  VirtualizedTranscriptRows,
} from './assistant-transcript-virtual-list.js';
import { Assistant } from './Assistant.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('virtual range retains all visualize rows and the keyboard-focused row', () => {
  assert.deepEqual(
    extractTranscriptVirtualRange({
      range: {
        startIndex: 5,
        endIndex: 7,
        overscan: 1,
        count: 20,
      },
      retainedIndexes: [9, 2],
      focusedIndex: 15,
    }),
    [2, 4, 5, 6, 7, 8, 9, 15],
  );
});

void test('commentary stays conversational while adjacent tool history remains collapsed', async () => {
  const messages = [
    {
      entryId: 'commentary-1',
      role: 'assistant' as const,
      content: 'Planning CSS updates for transcript styles',
      timestamp: '2026-07-12T00:00:00.000Z',
      metadata: { phase: 'commentary' as const },
    },
    toolMessage(
      'tool-call-1',
      'tool_call',
      JSON.stringify({
        callId: 'call-1',
        tool: 'read_file',
        args: { path: 'large.txt' },
      }),
    ),
    toolMessage(
      'tool-result-1',
      'tool_result',
      JSON.stringify({
        callId: 'call-1',
        tool: 'read_file',
        ok: true,
        displayText: 'DETAIL_SENTINEL',
        output: 'DETAIL_SENTINEL',
      }),
    ),
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  const settledTree = JSON.stringify(renderer.toJSON());
  assert.match(settledTree, /Planning CSS updates for transcript styles/u);
  assert.equal(
    settledTree.match(/Planning CSS updates for transcript styles/gu)?.length,
    1,
  );
  const settledReasoning = renderer.root.findByProps({
    className: 'reasoning-disclosure',
  });
  assert.equal(settledReasoning.type, 'details');
  assert.equal(settledReasoning.props.open, undefined);
  assert.deepEqual(settledReasoning.findAllByType('span').at(-1)?.children, [
    '추론',
  ]);
  assert.doesNotMatch(settledTree, /DETAIL_SENTINEL/u);
  assert.equal(
    renderer.root.findAllByProps({ className: 'transcript-virtual-row' })
      .length,
    2,
  );

  const toggle = renderer.root.findByProps({
    className: 'transcript-tool-group-toggle',
  });
  await act(async () => {
    toggle.props.onClick();
  });
  assert.match(JSON.stringify(renderer.toJSON()), /DETAIL_SENTINEL/);

  await act(async () => {
    renderer.unmount();
  });
});

void test('live commentary is not folded into a running tool activity row', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={[
          { kind: 'assistant_text', text: 'LIVE_COMMENTARY_SENTINEL' },
          { kind: 'tool_activity', tool: 'read_file', state: 'running' },
        ]}
        transcriptEntryKeys={['commentary', 'tool']}
        artifactsByRef={new Map()}
        isRunning={true}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  const liveTree = JSON.stringify(renderer.toJSON());
  assert.match(liveTree, /LIVE_COMMENTARY_SENTINEL/u);
  assert.equal(liveTree.match(/LIVE_COMMENTARY_SENTINEL/gu)?.length, 1);
  const liveReasoning = renderer.root.findByProps({
    className: 'reasoning-disclosure live',
  });
  assert.equal(liveReasoning.type, 'details');
  assert.equal(liveReasoning.props.open, true);
  assert.deepEqual(liveReasoning.findAllByType('span').at(-1)?.children, [
    '생각 중…',
  ]);
  assert.equal(
    renderer.root.findAllByProps({ className: 'transcript-virtual-row' })
      .length,
    2,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('PTC resource admission stays visible on live and settled collapsed tool groups', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={[
          { kind: 'tool_activity', tool: 'exec', state: 'running' },
          {
            kind: 'tool_activity',
            tool: 'exec',
            state: 'completed',
            ptcStatus: 'queued',
          },
        ]}
        transcriptEntryKeys={['ptc-call', 'ptc-result']}
        artifactsByRef={new Map()}
        isRunning={true}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  assert.equal(
    renderer.root.findAllByProps({
      className: 'transcript-tool-group-toggle',
    }).length,
    1,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /PTC 리소스 대기 중/);

  const settledMessages = [
    toolMessage(
      'ptc-settled-call',
      'tool_call',
      JSON.stringify({ callId: 'ptc-settled', tool: 'exec', args: {} }),
    ),
    toolMessage(
      'ptc-settled-result',
      'tool_result',
      JSON.stringify({
        callId: 'ptc-settled',
        tool: 'exec',
        ok: false,
        displayText: 'resource budget is insufficient',
        output: JSON.stringify({
          ok: false,
          errorCode: 'execution_failed',
          error: 'resource budget is insufficient',
          details: {
            kind: 'ptc_execute_code_error',
            reasonCode: 'resource_budget_insufficient',
            message: 'resource budget is insufficient',
          },
        }),
        errorCode: 'execution_failed',
        error: 'resource budget is insufficient',
      }),
    ),
  ];
  await act(async () => {
    renderer.update(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={settledMessages}
        messageKeys={settledMessages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });
  assert.match(JSON.stringify(renderer.toJSON()), /PTC 리소스 부족/);

  await act(async () => {
    renderer.unmount();
  });
});

void test('live ask_user renders as one card instead of a tool group', async () => {
  const answers: Array<{ answer: string; requestKey: string }> = [];
  const transcriptEntries = [
    {
      kind: 'tool_activity' as const,
      tool: 'ask_user',
      state: 'running' as const,
      callId: 'call-ask-live',
      args: {
        question: '어떻게 진행할까요?',
        options: [
          { label: '계속', description: '이어갑니다.' },
          { label: '중지', description: '멈춥니다.' },
        ],
      },
    },
    {
      kind: 'tool_activity' as const,
      tool: 'ask_user',
      state: 'completed' as const,
      callId: 'call-ask-live',
    },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={transcriptEntries}
        transcriptEntryKeys={['ask-call', 'ask-result']}
        artifactsByRef={new Map()}
        isRunning={true}
        rowInteractions={{
          onStartArtifactRun: () => {},
          onAskUserAnswer: (request) => {
            answers.push(request);
          },
        }}
      />,
    );
  });

  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    1,
  );
  assert.equal(
    renderer.root.findAllByProps({
      className: 'transcript-tool-group-toggle',
    }).length,
    0,
  );
  const continueButton = renderer.root.findAllByProps({
    className: 'ask-user-option',
  })[0];
  assert.ok(continueButton);
  await act(async () => {
    continueButton.props.onClick();
  });
  assert.deepEqual(answers, [{ answer: '계속', requestKey: 'call-ask-live' }]);

  await act(async () => {
    renderer.update(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={transcriptEntries}
        transcriptEntryKeys={['ask-call', 'ask-result']}
        artifactsByRef={new Map()}
        isRunning={true}
        rowInteractions={{
          onStartArtifactRun: () => {},
          onAskUserAnswer: (request) => {
            answers.push(request);
          },
          answeredAskUserRequestKeys: new Set(['call-ask-live']),
        }}
      />,
    );
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    0,
  );
  await act(async () => {
    renderer.unmount();
  });
});

void test('settled ask_user card disappears after the next user message', async () => {
  const askCall = toolMessage(
    'ask-call',
    'tool_call',
    JSON.stringify({
      callId: 'call-ask-settled',
      tool: 'ask_user',
      args: {
        question: '기준을 골라주세요.',
        options: [
          { label: '균형형', description: '고르게 평가합니다.' },
          { label: '논증형', description: '논리를 중점 평가합니다.' },
        ],
      },
    }),
  );
  const askResult = toolMessage(
    'ask-result',
    'tool_result',
    JSON.stringify({
      callId: 'call-ask-settled',
      tool: 'ask_user',
      ok: true,
      output: '{"asked":true}',
    }),
  );
  const legacyEcho: ThreadMessage = {
    entryId: 'ask-legacy-echo',
    role: 'assistant',
    content:
      '기준을 골라주세요. 균형형 또는 논증형 중에서 선택해 주세요. LEGACY_ASK_USER_ECHO',
    timestamp: '2026-07-21T23:59:59.000Z',
  };
  const messages = [askCall, askResult, legacyEcho];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{
          onStartArtifactRun: () => {},
          onAskUserAnswer: () => {},
        }}
      />,
    );
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(renderer.toJSON()),
    /LEGACY_ASK_USER_ECHO/u,
  );

  const answeredMessages: ThreadMessage[] = [
    ...messages,
    {
      entryId: 'ask-answer',
      role: 'user',
      content: '균형형',
      timestamp: '2026-07-22T00:00:00.000Z',
    },
  ];
  await act(async () => {
    renderer.update(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={answeredMessages}
        messageKeys={answeredMessages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{
          onStartArtifactRun: () => {},
          onAskUserAnswer: () => {},
        }}
      />,
    );
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'ask-user-card' }).length,
    0,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /균형형/u);
  await act(async () => {
    renderer.unmount();
  });
});

void test('settled ask_user keeps answered questions as read-only records while only the newest stays interactive', async () => {
  const buildAskCall = (entryId: string, callId: string, question: string) =>
    toolMessage(
      entryId,
      'tool_call',
      JSON.stringify({
        callId,
        tool: 'ask_user',
        args: {
          question,
          options: [
            { label: '계속', description: '이어갑니다.' },
            { label: '중지', description: '멈춥니다.' },
          ],
        },
      }),
    );
  const buildAskResult = (entryId: string, callId: string) =>
    toolMessage(
      entryId,
      'tool_result',
      JSON.stringify({
        callId,
        tool: 'ask_user',
        ok: true,
        output: '{"asked":true}',
      }),
    );
  const messages: ThreadMessage[] = [
    buildAskCall('ask-call-1', 'call-ask-1', '첫 번째 질문'),
    buildAskResult('ask-result-1', 'call-ask-1'),
    {
      entryId: 'ask-answer-1',
      role: 'user',
      content: '계속',
      timestamp: '2026-07-22T00:00:00.000Z',
    },
    buildAskCall('ask-call-2', 'call-ask-2', '두 번째 질문'),
    buildAskResult('ask-result-2', 'call-ask-2'),
  ];

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{
          onStartArtifactRun: () => {},
          onAskUserAnswer: () => {},
        }}
      />,
    );
  });

  // 답한 질문은 기록으로 남고, 상호작용은 최신 미답변 카드에만 열린다.
  // 질문이 사라지면 남은 답변만으로는 무엇에 답했는지 알 수 없다.
  const liveCards = renderer.root.findAllByProps({
    className: 'ask-user-card',
  });
  const answeredCards = renderer.root.findAllByProps({
    className: 'ask-user-card is-answered',
  });
  assert.equal(liveCards.length, 1, 'only the newest card stays interactive');
  assert.equal(answeredCards.length, 1, 'the answered question is preserved');

  const markup = JSON.stringify(renderer.toJSON());
  assert.match(markup, /첫 번째 질문/u);
  assert.match(markup, /두 번째 질문/u);

  // 기록 카드의 선택지는 다시 고를 수 없다.
  assert.equal(
    answeredCards[0]
      ?.findAllByProps({ className: 'ask-user-option' })
      .every((option) => option.props.disabled === true),
    true,
    'answered options must not be re-submittable',
  );
  // 이미 답한 질문에는 자유 답변 안내를 남기지 않는다.
  assert.equal(
    answeredCards[0]?.findAllByProps({ className: 'ask-user-hint' }).length,
    0,
  );
  await act(async () => {
    renderer.unmount();
  });
});

void test('active child activity stays in the shelf while terminal activity remains in transcript history', async () => {
  const transcriptEntries = [
    ...Array.from({ length: 5 }, (_, index) => ({
      kind: 'subagent_activity' as const,
      childRunId: `child-${index}`,
      childThreadId: `00000000-0000-4000-8000-00000000000${index}`,
      subagentType: 'explorer' as const,
      state: 'spawned' as const,
    })),
    {
      kind: 'subagent_activity' as const,
      deliveryId: 'delivery-terminal',
      childRunId: 'child-terminal',
      childThreadId: '00000000-0000-4000-8000-000000000099',
      subagentType: 'worker' as const,
      state: 'failed' as const,
      reason: 'daemon_restart' as const,
      result: '재시작 전에 남긴 부분 결과',
    },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={transcriptEntries}
        transcriptEntryKeys={transcriptEntries.map(
          (_, index) => `spawn-${index}`,
        )}
        artifactsByRef={new Map()}
        isRunning={true}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  assert.equal(
    renderer.root.findAllByProps({ className: 'transcript-virtual-row' })
      .length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /child-0/u);
  assert.match(JSON.stringify(renderer.toJSON()), /부분 결과/u);

  await act(async () => {
    renderer.unmount();
  });
});

void test('consecutive completed explorers collapse into one transcript group', async () => {
  const transcriptEntries = Array.from({ length: 3 }, (_, index) => ({
    kind: 'subagent_activity' as const,
    deliveryId: `delivery-completed-${index}`,
    childRunId: `child-completed-${index}`,
    childThreadId: `00000000-0000-4000-8000-00000000001${index}`,
    subagentType: 'explorer' as const,
    state: 'completed' as const,
    result: `탐색 결과 ${index}`,
  }));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={transcriptEntries}
        transcriptEntryKeys={transcriptEntries.map(
          (_, index) => `completed-${index}`,
        )}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  assert.equal(
    renderer.root.findAllByProps({
      className: 'subagent-work-summary subagent-work-group-toggle',
    }).length,
    1,
  );
  assert.equal(
    renderer.root
      .findByProps({ className: 'subagent-work-title' })
      .children.join(''),
    'explorer 작업 3개 완료',
  );
  assert.equal(
    renderer.root.findAllByProps({ className: 'subagent-work-card' }).length,
    0,
  );

  await act(async () => {
    renderer.root
      .findByProps({
        className: 'subagent-work-summary subagent-work-group-toggle',
      })
      .props.onClick();
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'subagent-work-card' }).length,
    3,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('long transcripts mount only the viewport rows', async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    entryId: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${index}`,
    timestamp: new Date(index).toISOString(),
  }));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  const mountedRows = renderer.root.findAllByProps({
    className: 'transcript-virtual-row',
  });
  assert.ok(mountedRows.length > 0);
  assert.ok(
    mountedRows.length >= 10,
    'the viewport keeps enough neighboring rows mounted to absorb the next scroll',
  );
  assert.ok(mountedRows.length < messages.length);

  await act(async () => {
    renderer.unmount();
  });
});

void test('past questions edit through the branch path while the last question keeps in-place regenerate', async () => {
  const pastEdits: Array<{ entryId: string; nextPrompt: string }> = [];
  const lastEdits: string[] = [];
  const messages: ThreadMessage[] = [
    {
      entryId: 'entry-q1',
      role: 'user',
      content: 'past question',
      timestamp: '2026-07-12T00:00:01.000Z',
    },
    {
      entryId: 'entry-a1',
      role: 'assistant',
      content: 'answer',
      timestamp: '2026-07-12T00:00:02.000Z',
    },
    {
      entryId: 'entry-q2',
      role: 'user',
      content: 'last question',
      timestamp: '2026-07-12T00:00:03.000Z',
    },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{ onStartArtifactRun: () => {} }}
        messageEditActions={{
          onEditLastUserPrompt: (nextPrompt) => {
            lastEdits.push(nextPrompt);
          },
          onEditPastUserPrompt: (entryId, nextPrompt) => {
            pastEdits.push({ entryId, nextPrompt });
          },
        }}
      />,
    );
  });

  // 질문 두 개 모두 ✎ 편집 진입점을 가진다
  const editButtons = renderer.root.findAllByProps({
    'aria-label': '질문 수정',
  });
  assert.equal(editButtons.length, 2);

  // 과거 질문(첫 번째) 편집 → 브랜치 경로 콜백에 entryId가 실려 간다
  await act(async () => {
    editButtons[0]!.props.onClick();
  });
  const textarea = renderer.root.findByType('textarea');
  await act(async () => {
    textarea.props.onChange({ target: { value: '고친 과거 질문' } });
  });
  const submit = renderer.root
    .findAllByType('button')
    .find((button) => button.props.children === '보내기');
  assert.ok(submit);
  await act(async () => {
    submit.props.onClick();
  });

  assert.deepEqual(pastEdits, [
    { entryId: 'entry-q1', nextPrompt: '고친 과거 질문' },
  ]);
  assert.deepEqual(lastEdits, []);

  await act(async () => {
    renderer.unmount();
  });
});

void test('typing stays inside the composer without remounting transcript rows', async () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    entryId: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${index}`,
    timestamp: new Date(index).toISOString(),
  }));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Assistant
        {...createAssistantProps({
          conversation: {
            messages,
          },
        })}
      />,
    );
  });

  const firstRow = renderer.root.findAllByProps({
    className: 'transcript-virtual-row',
  })[0];
  assert.ok(firstRow);
  const textarea = renderer.root.findByType('textarea');
  await act(async () => {
    textarea.props.onChange({ target: { value: '타이핑' } });
  });

  assert.equal(
    renderer.root.findAllByProps({ className: 'transcript-virtual-row' })[0],
    firstRow,
  );
  assert.equal(renderer.root.findByType('textarea').props.value, '타이핑');

  await act(async () => {
    renderer.unmount();
  });
});

void test('settled reasoning disclosure stays separate from the final answer', async () => {
  const messages: ThreadMessage[] = [
    {
      entryId: 'reasoning-separate',
      role: 'assistant',
      content: 'REASONING_SEPARATION_SENTINEL',
      timestamp: '2026-07-26T00:00:00.000Z',
      metadata: { phase: 'commentary' },
    },
    {
      entryId: 'answer-separate',
      role: 'assistant',
      content: 'FINAL_ANSWER_SEPARATION_SENTINEL',
      timestamp: '2026-07-26T00:00:01.000Z',
      metadata: { phase: 'final_answer' },
    },
  ];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        shouldApplyVirtualizerScroll={() => false}
        isProgrammaticTranscriptScroll={() => false}
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        rowInteractions={{ onStartArtifactRun: () => {} }}
      />,
    );
  });

  const tree = JSON.stringify(renderer.toJSON());
  assert.equal(tree.match(/REASONING_SEPARATION_SENTINEL/gu)?.length, 1);
  assert.equal(tree.match(/FINAL_ANSWER_SEPARATION_SENTINEL/gu)?.length, 1);
  assert.equal(
    renderer.root.findAllByProps({ className: 'reasoning-disclosure' }).length,
    1,
  );
  assert.equal(
    renderer.root.findAllByProps({
      className: 'transcript-message from-assistant',
    }).length,
    1,
  );

  await act(async () => {
    renderer.unmount();
  });
});
