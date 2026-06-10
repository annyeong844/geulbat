import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildResponseCreatePayload } from './responses-wire-input.js';
import { streamResponsesOverWebSocket } from './responses-websocket.js';

const baseBody = {
  model: 'test-model',
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

void test('streamResponsesOverWebSocket can emit sanitized discovery snapshots without changing parse behavior', async () => {
  const sentPayloads: string[] = [];
  const discoveryRequests: unknown[] = [];
  const discoveryEvents: unknown[] = [];
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send(payload: string): void;
    close(code?: number, reason?: string): void;
  };
  socket.readyState = 1;
  socket.send = (payload: string) => {
    sentPayloads.push(payload);
  };
  socket.close = () => {};

  const runPromise = streamResponsesOverWebSocket({
    body: {
      model: 'test-model',
      store: false,
      stream: true,
      instructions: 'private system prompt',
      text: { verbosity: 'medium' },
      reasoning: { effort: 'medium', summary: 'auto' },
    },
    headers: new Headers({
      Authorization: 'Bearer live-token-secret',
      'chatgpt-account-id': 'acct-secret',
      session_id: 'session-secret',
    }),
    history: [{ kind: 'user', text: 'private user text' }],
    providerSessionId: 'session-secret',
    providerWebSocketSessions: {
      async acquireWebSocket() {
        return {
          socket,
          entry: { socket, busy: true, idleTimer: undefined },
          release() {},
        };
      },
    },
    discoverySink: {
      recordRequest(snapshot) {
        discoveryRequests.push(snapshot);
      },
      recordEvent(snapshot) {
        discoveryEvents.push(snapshot);
      },
    },
  });

  await setImmediatePromise();
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.output_item.added',
        item: { id: 'item-secret', type: 'message', phase: 'final_answer' },
      }),
    ),
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.output_text.delta',
        item_id: 'item-secret',
        delta: 'hello',
      }),
    ),
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'item-secret',
          type: 'message',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      }),
    ),
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 1 } },
      }),
    ),
  );

  const result = await runPromise;

  assert.equal(result.finalText, 'hello');
  assert.equal(sentPayloads.length, 1);
  assert.equal(discoveryRequests.length, 1);
  assert.equal(discoveryEvents.length, 4);
  const discoveryJson = JSON.stringify({ discoveryRequests, discoveryEvents });
  assert.doesNotMatch(
    discoveryJson,
    /live-token-secret|acct-secret|session-secret|private user text|private system prompt|item-secret|hello/u,
  );
  assert.match(discoveryJson, /\[redacted:provider-id\]/u);
  assert.match(discoveryJson, /\[redacted:provider-text\]/u);
});

function setImmediatePromise(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
