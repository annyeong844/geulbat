import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoryItem } from '../wire/types.js';
import { buildResponseWireInput } from './responses-wire-input.js';

void test('buildResponseWireInput sends user attachments as image and file content blocks', () => {
  const history: HistoryItem[] = [
    {
      kind: 'user',
      text: '이 이미지 좀 봐줘',
      attachments: [
        {
          kind: 'image',
          name: '증상.png',
          mimeType: 'image/png',
          dataBase64: 'aGVsbG8=',
        },
        {
          kind: 'text',
          name: 'notes.md',
          text: '# 메모',
        },
      ],
    },
  ];

  const input = buildResponseWireInput(history) as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;

  assert.equal(input.length, 1);
  const content = input[0]!.content;
  assert.equal(content[0]!.type, 'input_text');
  assert.equal(content[0]!.text, '이 이미지 좀 봐줘');
  // codex local image 규약: 이름 태그로 이미지 블록을 감싼다
  assert.equal(content[1]!.type, 'input_text');
  assert.equal(content[1]!.text, '<image name="증상.png">');
  assert.equal(content[2]!.type, 'input_image');
  assert.equal(content[2]!.image_url, 'data:image/png;base64,aGVsbG8=');
  assert.equal(content[3]!.type, 'input_text');
  assert.equal(content[3]!.text, '</image>');
  assert.equal(content[4]!.type, 'input_text');
  assert.equal(content[4]!.text, '<file name="notes.md">\n# 메모\n</file>');
});

void test('buildResponseWireInput sends pdf attachments as input_file blocks', () => {
  const input = buildResponseWireInput([
    {
      kind: 'user',
      text: '이 PDF 요약해줘',
      attachments: [
        {
          kind: 'pdf',
          name: 'x-haness.pdf',
          mimeType: 'application/pdf',
          dataBase64: 'JVBERi0=',
        },
      ],
    },
  ]) as Array<{ content: Array<Record<string, unknown>> }>;

  const content = input[0]!.content;
  assert.equal(content[1]!.type, 'input_file');
  assert.equal(content[1]!.filename, 'x-haness.pdf');
  assert.equal(content[1]!.file_data, 'data:application/pdf;base64,JVBERi0=');
});

void test('buildResponseWireInput keeps plain user items as a single text block', () => {
  const input = buildResponseWireInput([
    { kind: 'user', text: '안녕' },
  ]) as Array<{ content: Array<Record<string, unknown>> }>;

  assert.equal(input[0]!.content.length, 1);
  assert.equal(input[0]!.content[0]!.type, 'input_text');
});

void test('buildResponseWireInput replays a provider-native replacement only for its pinned model', () => {
  const history: HistoryItem[] = [
    {
      kind: 'provider_native_compaction',
      providerId: 'openai_codex_direct',
      model: 'model-a',
      output: [
        {
          type: 'compaction',
          encrypted_content: 'encrypted-checkpoint',
        },
      ],
    },
    { kind: 'user', text: 'new tail' },
  ];

  const input = buildResponseWireInput(history, {
    providerId: 'openai_codex_direct',
    model: 'model-a',
  }) as Array<Record<string, unknown>>;

  assert.equal(input[0]?.['type'], 'compaction');
  assert.equal(input[1]?.['role'], 'user');
  assert.throws(
    () =>
      buildResponseWireInput(history, {
        providerId: 'openai_codex_direct',
        model: 'model-b',
      }),
    /provider-native compaction history is incompatible/,
  );
  assert.throws(
    () => buildResponseWireInput(history),
    /provider-native compaction history is incompatible/,
  );
});

void test('buildResponseWireInput replays opaque provider output before function outputs', () => {
  const reasoningItem = {
    id: 'rs_1',
    type: 'reasoning',
    encrypted_content: 'opaque-reasoning',
  };
  const functionCallItem = {
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_1',
    name: 'read_file',
    arguments: '{"path":"README.md"}',
  };
  const history: HistoryItem[] = [
    { kind: 'backend_item', data: reasoningItem },
    { kind: 'backend_item', data: functionCallItem },
    {
      kind: 'function_call_output',
      callId: 'call_1',
      output: '{"ok":true}',
    },
  ];

  assert.deepEqual(buildResponseWireInput(history), [
    reasoningItem,
    functionCallItem,
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"ok":true}',
    },
  ]);
});

void test('buildResponseWireInput keeps batched calls before call-ordered outputs', () => {
  const reasoningItem = {
    id: 'rs_parallel',
    type: 'reasoning',
    encrypted_content: 'opaque-parallel-reasoning',
  };
  const functionCallA = {
    id: 'fc_a',
    type: 'function_call',
    call_id: 'call_a',
    name: 'read_file',
    arguments: '{"path":"A.md"}',
  };
  const functionCallB = {
    id: 'fc_b',
    type: 'function_call',
    call_id: 'call_b',
    name: 'read_file',
    arguments: '{"path":"B.md"}',
  };

  assert.deepEqual(
    buildResponseWireInput([
      { kind: 'backend_item', data: reasoningItem },
      { kind: 'backend_item', data: functionCallA },
      { kind: 'backend_item', data: functionCallB },
      {
        kind: 'function_call_output',
        callId: 'call_a',
        output: '{"result":"A"}',
      },
      {
        kind: 'function_call_output',
        callId: 'call_b',
        output: '{"result":"B"}',
      },
    ]),
    [
      reasoningItem,
      functionCallA,
      functionCallB,
      {
        type: 'function_call_output',
        call_id: 'call_a',
        output: '{"result":"A"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_b',
        output: '{"result":"B"}',
      },
    ],
  );
});

void test('buildResponseWireInput rejects an invalid opaque provider history item', () => {
  assert.throws(
    () => buildResponseWireInput([{ kind: 'backend_item', data: 'invalid' }]),
    /provider history item is invalid/u,
  );
});

void test('buildResponseWireInput rejects duplicate normalized and provider function-call replay', () => {
  assert.throws(
    () =>
      buildResponseWireInput([
        {
          kind: 'function_call',
          id: 'fc-normalized',
          callId: 'call-1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
        {
          kind: 'backend_item',
          data: {
            id: 'fc-provider',
            type: 'function_call',
            call_id: 'call-1',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        },
      ]),
    /provider history item is invalid/u,
  );
});

void test('buildResponseWireInput rejects normalized function-call replay for Codex direct', () => {
  const normalizedFunctionCall = {
    kind: 'function_call' as const,
    id: 'fc-normalized',
    callId: 'call-1',
    name: 'read_file',
    arguments: '{"path":"README.md"}',
  };

  assert.throws(
    () =>
      buildResponseWireInput([normalizedFunctionCall], {
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
      }),
    /provider history item is invalid/u,
  );
  assert.deepEqual(
    buildResponseWireInput([normalizedFunctionCall], {
      providerId: 'grok_oauth',
      model: 'grok-test',
    }),
    [
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    ],
  );
});

void test('buildResponseWireInput rejects duplicate provider function-call ids', () => {
  const functionCall = {
    id: 'fc-provider',
    type: 'function_call',
    call_id: 'call-1',
    name: 'read_file',
    arguments: '{"path":"README.md"}',
  };

  assert.throws(
    () =>
      buildResponseWireInput([
        { kind: 'backend_item', data: functionCall },
        { kind: 'backend_item', data: { ...functionCall, id: 'fc-copy' } },
      ]),
    /provider history item is invalid/u,
  );
});
