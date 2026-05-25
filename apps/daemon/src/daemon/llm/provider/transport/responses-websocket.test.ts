import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResponseCreatePayload } from './responses-websocket.js';

const baseBody = {
  model: 'gpt-5.4',
  store: false,
  stream: true,
  instructions: 'system',
  text: { verbosity: 'medium' },
  reasoning: { effort: 'medium', summary: 'auto' },
} as const;

void test('buildResponseCreatePayload sends full context on first turn', () => {
  const payload = buildResponseCreatePayload(baseBody, [
    { kind: 'user', text: '안녕' },
  ]);

  assert.equal(payload.type, 'response.create');
  assert.deepEqual(payload.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: '안녕' }],
    },
  ]);
});

void test('buildResponseCreatePayload keeps full structured context when tool results exist', () => {
  const payload = buildResponseCreatePayload(baseBody, [
    { kind: 'user', text: '안녕' },
    { kind: 'assistant', phase: 'commentary', text: '파일을 확인해볼게요.' },
    {
      kind: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"hello.txt"}',
    },
    {
      kind: 'function_call_output',
      callId: 'call_1',
      output: '{"content":"hello"}',
    },
  ]);

  assert.deepEqual(payload.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: '안녕' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'output_text', text: '파일을 확인해볼게요.' }],
      phase: 'commentary',
    },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"hello.txt"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"content":"hello"}',
    },
  ]);
});

void test('buildResponseCreatePayload keeps full context for later user turns', () => {
  const payload = buildResponseCreatePayload(baseBody, [
    { kind: 'user', text: '안녕' },
    { kind: 'assistant', phase: 'final_answer', text: '안녕하세요' },
    { kind: 'user', text: '반가워' },
  ]);

  assert.deepEqual(payload.input, [
    {
      role: 'user',
      content: [{ type: 'input_text', text: '안녕' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'output_text', text: '안녕하세요' }],
      phase: 'final_answer',
    },
    {
      role: 'user',
      content: [{ type: 'input_text', text: '반가워' }],
    },
  ]);
});
