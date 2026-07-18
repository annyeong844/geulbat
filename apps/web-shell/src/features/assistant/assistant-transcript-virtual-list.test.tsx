import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import type { ThreadMessage } from '@geulbat/protocol/threads';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  getRunTranscriptEntryBaseKey,
  getThreadMessageBaseKey,
} from './assistant-transcript-content.js';
import { VirtualizedTranscriptRows } from './assistant-transcript-virtual-list.js';
import { Assistant } from './Assistant.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('message render identity uses entryId instead of copying message content', () => {
  const message = toolMessage(
    'stable-entry-id',
    'tool_result',
    'LARGE_OUTPUT_SENTINEL'.repeat(10_000),
  );

  assert.equal(getThreadMessageBaseKey(message), 'message:stable-entry-id');
  assert.equal(
    getRunTranscriptEntryBaseKey({
      kind: 'assistant_text',
      text: 'STREAMING_OUTPUT_SENTINEL'.repeat(10_000),
    }),
    'assistant_text',
  );
  assert.equal(
    getRunTranscriptEntryBaseKey({
      kind: 'tool_activity',
      tool: 'read_file',
      state: 'running',
    }),
    getRunTranscriptEntryBaseKey({
      kind: 'tool_activity',
      tool: 'read_file',
      state: 'completed',
    }),
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
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        onStartArtifactRun={() => {}}
      />,
    );
  });

  assert.match(
    JSON.stringify(renderer.toJSON()),
    /Planning CSS updates for transcript styles/,
  );
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /DETAIL_SENTINEL/);
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
        messages={[]}
        messageKeys={[]}
        transcriptEntries={[
          { kind: 'assistant_text', text: 'LIVE_COMMENTARY_SENTINEL' },
          { kind: 'tool_activity', tool: 'read_file', state: 'running' },
        ]}
        transcriptEntryKeys={['commentary', 'tool']}
        artifactsByRef={new Map()}
        isRunning={true}
        onStartArtifactRun={() => {}}
      />,
    );
  });

  assert.match(JSON.stringify(renderer.toJSON()), /LIVE_COMMENTARY_SENTINEL/);
  assert.equal(
    renderer.root.findAllByProps({ className: 'transcript-virtual-row' })
      .length,
    2,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('consecutive child launches render as one collapsed spawn wave', async () => {
  const transcriptEntries = Array.from({ length: 5 }, (_, index) => ({
    kind: 'subagent_activity' as const,
    childRunId: `child-${index}`,
    childThreadId: `00000000-0000-4000-8000-00000000000${index}`,
    subagentType: 'explorer' as const,
    state: 'spawned' as const,
  }));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VirtualizedTranscriptRows
        scrollElementRef={React.createRef<HTMLDivElement>()}
        messages={[]}
        messageKeys={[]}
        transcriptEntries={transcriptEntries}
        transcriptEntryKeys={transcriptEntries.map(
          (_, index) => `spawn-${index}`,
        )}
        artifactsByRef={new Map()}
        isRunning={true}
        onStartArtifactRun={() => {}}
      />,
    );
  });

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /보조 작업 5개 시작/);
  assert.equal(
    renderer.root.findAllByProps({
      className: 'transcript-subagent-group-toggle',
    }).length,
    1,
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
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        onStartArtifactRun={() => {}}
      />,
    );
  });

  const mountedRows = renderer.root.findAllByProps({
    className: 'transcript-virtual-row',
  });
  assert.ok(mountedRows.length > 0);
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
        messages={messages}
        messageKeys={messages.map((message) => message.entryId)}
        transcriptEntries={[]}
        transcriptEntryKeys={[]}
        artifactsByRef={new Map()}
        isRunning={false}
        onStartArtifactRun={() => {}}
        onEditLastUserPrompt={(nextPrompt) => {
          lastEdits.push(nextPrompt);
        }}
        onEditPastUserPrompt={(entryId, nextPrompt) => {
          pastEdits.push({ entryId, nextPrompt });
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
        messages={messages}
        backgroundNotifications={[]}
        transcriptEntries={[]}
        finalAnswerText=""
        streamError={null}
        isRunning={false}
        onSend={() => {}}
        onStartArtifactRun={() => {}}
        onCancel={() => {}}
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

function toolMessage(
  entryId: string,
  role: 'tool_call' | 'tool_result',
  content: string,
): ThreadMessage {
  return {
    entryId,
    role,
    content,
    timestamp: '2026-07-12T00:00:00.000Z',
  };
}
