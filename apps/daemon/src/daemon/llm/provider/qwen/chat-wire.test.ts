import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';
import type { HistoryItem } from '../wire/types.js';
import { buildQwenChatMessages, measureQwenChatHistoryBytes } from './index.js';

void test('Qwen chat wire groups reasoning, final text, tool calls, and tool outputs', () => {
  const history: HistoryItem[] = [
    { kind: 'user', text: 'Inspect this.' },
    { kind: 'assistant', phase: 'commentary', text: 'I will inspect.' },
    { kind: 'assistant', phase: 'final_answer', text: 'Calling a tool.' },
    {
      kind: 'function_call',
      id: 'item-1',
      callId: 'call-1',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    },
    {
      kind: 'function_call_output',
      callId: 'call-1',
      output: '{"content":"Geulbat"}',
    },
  ];

  assert.deepEqual(buildQwenChatMessages({ history }), [
    { role: 'user', content: 'Inspect this.' },
    {
      role: 'assistant',
      content: 'Calling a tool.',
      reasoning_content: 'I will inspect.',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"content":"Geulbat"}',
    },
  ]);
  assert.equal(
    measureQwenChatHistoryBytes({ history }),
    Buffer.byteLength(
      JSON.stringify(buildQwenChatMessages({ history })),
      'utf8',
    ),
  );
});

void test('Qwen chat wire converts image and text attachments without losing user text', () => {
  assert.deepEqual(
    buildQwenChatMessages({
      history: [
        {
          kind: 'user',
          text: 'Describe these.',
          attachments: [
            {
              kind: 'image',
              name: 'figure.png',
              mimeType: 'image/png',
              dataBase64: 'aW1hZ2U=',
            },
            { kind: 'text', name: 'notes.txt', text: 'supporting notes' },
          ],
        },
      ],
    }),
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe these.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
          },
          {
            type: 'text',
            text: 'Attachment notes.txt:\nsupporting notes',
          },
        ],
      },
    ],
  );
});

void test('Qwen chat wire explicitly rejects PDF attachments', () => {
  assert.throws(
    () =>
      buildQwenChatMessages({
        history: [
          {
            kind: 'user',
            text: '',
            attachments: [
              {
                kind: 'pdf',
                name: 'paper.pdf',
                mimeType: 'application/pdf',
                dataBase64: 'cGRm',
              },
            ],
          },
        ],
      }),
    /does not support PDF attachment 'paper\.pdf'/u,
  );
});

void test('Qwen chat wire replays scoped synthetic provider items and rejects scope mismatch', () => {
  const scope = `sha256:${'a'.repeat(64)}` as ProviderReplayScopeId;
  const item: HistoryItem = {
    kind: 'backend_item',
    providerReplayScopeId: scope,
    data: {
      type: 'message',
      id: 'answer-1',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Recovered answer.' }],
    },
  };

  assert.deepEqual(
    buildQwenChatMessages({ history: [item], providerReplayScopeId: scope }),
    [{ role: 'assistant', content: 'Recovered answer.' }],
  );
  assert.throws(
    () =>
      buildQwenChatMessages({
        history: [item],
        providerReplayScopeId:
          `sha256:${'b'.repeat(64)}` as ProviderReplayScopeId,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'ProviderReplayScopeMismatchError' &&
      (error as Error & { llmCode?: unknown }).llmCode === 'llm_auth_failed',
  );
});
