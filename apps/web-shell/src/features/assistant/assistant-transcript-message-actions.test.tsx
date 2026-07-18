import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  TranscriptMessage,
  TranscriptTextMessage,
} from './assistant-transcript-message.js';
import { setToolDiffExpandedDefault } from './tool-diff-prefs.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('apply_patch tool_call renders a collapsed diff that follows the global default', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/app.ts',
    '@@',
    '-const b = 2;',
    '+const b = 3;',
    '*** End Patch',
  ].join('\n');
  const message = {
    entryId: 'entry-diff-1',
    role: 'tool_call' as const,
    content: JSON.stringify({
      id: 'fc-1',
      callId: 'call-1',
      tool: 'apply_patch',
      args: { patch },
    }),
    timestamp: '2026-07-12T00:00:00.000Z',
  };

  setToolDiffExpandedDefault(false);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptMessage
        message={message}
        artifactsByRef={new Map()}
        isRunning={false}
      />,
    );
  });

  // 접힌 상태 — 헤더(경로·변경량)만 보이고 본문은 렌더되지 않는다
  const header = renderer.root.findByProps({ className: 'tool-diff-header' });
  assert.match(JSON.stringify(renderer.toJSON()), /src\/app\.ts/);
  assert.match(JSON.stringify(renderer.toJSON()), /"\+","1"/);
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-diff-body' }).length,
    0,
  );

  // 헤더 클릭 → 본문 펼침
  await act(async () => {
    header.props.onClick();
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-diff-body' }).length,
    1,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /\+const b = 3;/);
  await act(async () => {
    renderer.unmount();
  });

  // 전역 기본값 온 → 처음부터 펼쳐진 채로 렌더
  setToolDiffExpandedDefault(true);
  let expandedByDefault!: ReactTestRenderer;
  await act(async () => {
    expandedByDefault = TestRenderer.create(
      <TranscriptMessage
        message={message}
        artifactsByRef={new Map()}
        isRunning={false}
      />,
    );
  });
  assert.equal(
    expandedByDefault.root.findAllByProps({ className: 'tool-diff-body' })
      .length,
    1,
  );
  await act(async () => {
    expandedByDefault.unmount();
  });
  setToolDiffExpandedDefault(false);
});

void test('tool_result renders a collapsed summary block that expands to pretty output', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptMessage
        message={{
          entryId: 'entry-result-1',
          role: 'tool_result',
          content: JSON.stringify({
            callId: 'call-9',
            tool: 'write_file',
            ok: true,
            computerFilesMayHaveChanged: true,
            displayText: JSON.stringify({ path: 'notes.txt', ok: true }),
          }),
          timestamp: '2026-07-12T00:00:00.000Z',
        }}
        artifactsByRef={new Map()}
        isRunning={false}
      />,
    );
  });

  // 접힌 상태 — 도구명 + ✓ 헤더만
  const header = renderer.root.findByProps({ className: 'tool-diff-header' });
  assert.match(JSON.stringify(renderer.toJSON()), /write_file/);
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-result-status ok' }).length,
    1,
  );
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-diff-body' }).length,
    0,
  );

  await act(async () => {
    header.props.onClick();
  });
  // pretty print된 본문("path": "notes.txt")이 펼쳐졌는지 — stringify 이스케이프 고려
  assert.match(JSON.stringify(renderer.toJSON()), /path.*notes\.txt/);
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-diff-body' }).length,
    1,
  );
  await act(async () => {
    renderer.unmount();
  });
});

void test('failed tool_result shows the error in the collapsed header', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptMessage
        message={{
          entryId: 'entry-result-2',
          role: 'tool_result',
          content: JSON.stringify({
            callId: 'call-10',
            tool: 'read_file',
            ok: false,
            computerFilesMayHaveChanged: false,
            displayText: 'file not found',
            error: 'file not found',
          }),
          timestamp: '2026-07-12T00:00:00.000Z',
        }}
        artifactsByRef={new Map()}
        isRunning={false}
      />,
    );
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-result-status failed' })
      .length,
    1,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /file not found/);
  await act(async () => {
    renderer.unmount();
  });
});

void test('non-diff tool_call renders a compact role-aware block without raw arguments', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptMessage
        message={{
          entryId: 'entry-exec-1',
          role: 'tool_call',
          content: JSON.stringify({
            id: 'fc-2',
            callId: 'call-2',
            tool: 'exec_command',
            args: { command: 'RAW_COMMAND_SENTINEL' },
          }),
          timestamp: '2026-07-12T00:00:00.000Z',
        }}
        artifactsByRef={new Map()}
        isRunning={false}
      />,
    );
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-diff-header' }).length,
    0,
  );
  assert.equal(
    renderer.root.findAllByProps({ className: 'tool-call-summary' }).length,
    1,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /exec_command/);
  assert.doesNotMatch(
    JSON.stringify(renderer.toJSON()),
    /RAW_COMMAND_SENTINEL/,
  );
  await act(async () => {
    renderer.unmount();
  });
});

void test('user message edit flow submits the revised prompt', async () => {
  const submitted: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TranscriptTextMessage
        messageRole="user"
        content="원래 질문"
        actions={{
          onEditSubmit: (nextPrompt) => {
            submitted.push(nextPrompt);
          },
        }}
      />,
    );
  });

  const editButton = renderer.root.findByProps({ 'aria-label': '질문 수정' });
  await act(async () => {
    editButton.props.onClick();
  });

  const textarea = renderer.root.findByProps({ 'aria-label': '질문 수정' });
  await act(async () => {
    textarea.props.onChange({ target: { value: '고친 질문' } });
  });

  const sendButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props.children === '보내기');
  assert.ok(sendButton);
  await act(async () => {
    sendButton.props.onClick();
  });

  assert.deepEqual(submitted, ['고친 질문']);

  await act(async () => {
    renderer.unmount();
  });
});

void test('assistant message actions include branch when provided, user messages never do', async () => {
  let branchClicks = 0;
  let withBranch!: ReactTestRenderer;
  await act(async () => {
    withBranch = TestRenderer.create(
      <TranscriptTextMessage
        messageRole="assistant"
        content="답변"
        actions={{
          onBranch: () => {
            branchClicks += 1;
          },
        }}
      />,
    );
  });
  const branchButton = withBranch.root.findByProps({
    'aria-label': '여기서 새 채팅',
  });
  await act(async () => {
    branchButton.props.onClick();
  });
  assert.equal(branchClicks, 1);
  await act(async () => {
    withBranch.unmount();
  });

  // 사용자 메시지에는 브랜치 핸들러가 있어도 버튼을 그리지 않는다
  let userMessage!: ReactTestRenderer;
  await act(async () => {
    userMessage = TestRenderer.create(
      <TranscriptTextMessage
        messageRole="user"
        content="질문"
        actions={{ onBranch: () => {} }}
      />,
    );
  });
  assert.equal(
    userMessage.root.findAllByProps({ 'aria-label': '여기서 새 채팅' }).length,
    0,
  );
  await act(async () => {
    userMessage.unmount();
  });
});

void test('assistant message actions include retry only when provided', async () => {
  let withRetry!: ReactTestRenderer;
  await act(async () => {
    withRetry = TestRenderer.create(
      <TranscriptTextMessage
        messageRole="assistant"
        content="답변"
        actions={{ onRetry: () => {} }}
      />,
    );
  });
  assert.equal(
    withRetry.root.findAllByProps({ 'aria-label': '답변 다시 시도' }).length,
    1,
  );
  await act(async () => {
    withRetry.unmount();
  });

  let withoutRetry!: ReactTestRenderer;
  await act(async () => {
    withoutRetry = TestRenderer.create(
      <TranscriptTextMessage messageRole="assistant" content="답변" />,
    );
  });
  assert.equal(
    withoutRetry.root.findAllByProps({ 'aria-label': '답변 다시 시도' }).length,
    0,
  );
  // 복사는 항상 제공
  assert.equal(
    withoutRetry.root.findAllByProps({ 'aria-label': '메시지 복사' }).length,
    1,
  );
  await act(async () => {
    withoutRetry.unmount();
  });
});
