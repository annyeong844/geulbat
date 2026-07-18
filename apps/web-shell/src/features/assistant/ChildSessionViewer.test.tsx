import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import { brandThreadId } from '../../lib/id-brand-helpers.js';
import {
  ChildSessionViewer,
  type ChildSessionTarget,
} from './ChildSessionViewer.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHILD_THREAD_ID = '00000000-0000-4000-8000-000000000777';

function makeTarget(): ChildSessionTarget {
  return {
    kind: 'subagent_activity',
    childRunId: 'run-child-1',
    childThreadId: CHILD_THREAD_ID,
    subagentType: 'explorer',
    state: 'completed',
    elapsedMs: 12_000,
    usage: { inputTokens: 1_500, outputTokens: 300, cachedInputTokens: 0 },
  };
}

function makeDetail(): ThreadDetailResponse {
  return {
    threadId: brandThreadId(CHILD_THREAD_ID),
    snapshotVersion: 'v1',
    messages: [
      {
        entryId: 'entry-1',
        role: 'user',
        content: 'Inspect subsystem A',
        timestamp: '2026-07-12T00:00:00.000Z',
      },
      {
        entryId: 'entry-2',
        role: 'assistant',
        content: 'I will inspect the relevant owner first.',
        timestamp: '2026-07-12T00:00:01.000Z',
        metadata: { phase: 'commentary' },
      },
      {
        entryId: 'entry-3',
        role: 'tool_call',
        content: JSON.stringify({
          callId: 'call-child-1',
          tool: 'read_file',
          args: { path: 'TOOL_CALL_RAW_SENTINEL' },
        }),
        timestamp: '2026-07-12T00:00:02.000Z',
      },
      {
        entryId: 'entry-4',
        role: 'tool_result',
        content: JSON.stringify({
          callId: 'call-child-1',
          tool: 'read_file',
          ok: true,
          displayText: 'TOOL_RESULT_RAW_SENTINEL',
          output: 'TOOL_RESULT_RAW_SENTINEL',
        }),
        timestamp: '2026-07-12T00:00:03.000Z',
      },
      {
        entryId: 'entry-5',
        role: 'assistant',
        content: 'child complete: Inspect subsystem A',
        timestamp: '2026-07-12T00:00:05.000Z',
      },
    ],
    artifacts: [],
  };
}

void test('ChildSessionViewer loads and renders the child thread transcript', async () => {
  let requestedThreadId = '';
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ChildSessionViewer
        target={makeTarget()}
        onClose={() => {}}
        loadThread={async (threadId) => {
          requestedThreadId = threadId;
          return makeDetail();
        }}
      />,
    );
  });

  assert.equal(requestedThreadId, CHILD_THREAD_ID);

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /보조 작업 세션/);
  assert.match(rendered, /explorer/);
  assert.match(rendered, /12s/);
  assert.match(rendered, /Inspect subsystem A/);
  assert.match(rendered, /I will inspect the relevant owner first/);
  assert.match(rendered, /child complete: Inspect subsystem A/);
  assert.doesNotMatch(rendered, /TOOL_CALL_RAW_SENTINEL/);
  assert.doesNotMatch(rendered, /TOOL_RESULT_RAW_SENTINEL/);
  assert.equal(
    renderer.root.findAllByProps({
      className: 'transcript-tool-group-toggle',
    }).length,
    1,
  );

  await act(async () => {
    renderer.unmount();
  });
});

void test('ChildSessionViewer surfaces a load failure instead of an empty panel', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ChildSessionViewer
        target={makeTarget()}
        onClose={() => {}}
        loadThread={async () => {
          throw new Error('thread transcript is corrupted');
        }}
      />,
    );
  });

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /불러오기 실패/);
  assert.match(rendered, /thread transcript is corrupted/);

  await act(async () => {
    renderer.unmount();
  });
});

void test('ChildSessionViewer close affordances call onClose', async () => {
  let closeCount = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ChildSessionViewer
        target={makeTarget()}
        onClose={() => {
          closeCount += 1;
        }}
        loadThread={async () => makeDetail()}
      />,
    );
  });

  const closeButton = renderer.root.findByProps({
    className: 'child-session-close',
  });
  await act(async () => {
    closeButton.props.onClick();
  });
  assert.equal(closeCount, 1);

  const backdrop = renderer.root.findByProps({
    className: 'child-session-backdrop',
  });
  await act(async () => {
    backdrop.props.onClick();
  });
  assert.equal(closeCount, 2);

  const overlay = renderer.root.findByProps({
    className: 'child-session-overlay',
  });
  let prevented = false;
  await act(async () => {
    overlay.props.onKeyDown({
      key: 'Escape',
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
  });
  assert.equal(prevented, true);
  assert.equal(closeCount, 3);

  await act(async () => {
    renderer.unmount();
  });
});
