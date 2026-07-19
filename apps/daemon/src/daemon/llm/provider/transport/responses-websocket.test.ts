import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildResponseCreatePayload } from './responses-wire-input.js';
import {
  extractWebSocketCloseError,
  extractWebSocketError,
} from './responses-websocket-errors.js';
import {
  resolveCodexResponsesUrl,
  resolveCodexWebSocketUrl,
} from './responses-websocket-url.js';
import {
  resolveResponsesStreamIdleTimeoutMs,
  streamResponsesOverWebSocket,
} from './responses-websocket.js';
import type { ResponsesWebSocketReusePolicy } from './responses-websocket-cache.js';

const TEST_REUSE_POLICY = {
  idleRetentionMs: 30,
  maxConnectionLifetimeMs: 60,
} as const satisfies ResponsesWebSocketReusePolicy;

const baseBody = {
  model: 'test-model',
  store: false,
  stream: true,
  instructions: 'system',
  text: { verbosity: 'medium' },
  reasoning: { effort: 'medium', summary: 'auto' },
} as const;

void test('WebSocket URL resolution preserves configured Codex endpoints and local proxies', () => {
  assert.equal(
    resolveCodexResponsesUrl('https://api.openai.com/v1/codex/'),
    'https://api.openai.com/v1/codex/responses',
  );
  assert.equal(
    resolveCodexWebSocketUrl('https://api.openai.com/v1/codex'),
    'wss://api.openai.com/v1/codex/responses',
  );
  assert.equal(
    resolveCodexWebSocketUrl('https://api.openai.com/v1'),
    'wss://api.openai.com/v1/codex/responses',
  );
  assert.equal(
    resolveCodexWebSocketUrl('http://127.0.0.1:8787/v1/codex/responses/'),
    'ws://127.0.0.1:8787/v1/codex/responses',
  );
});

void test('WebSocket error extraction accepts browser-style message events', () => {
  const browserError = extractWebSocketError({ message: 'proxy disconnected' });
  const genericError = extractWebSocketError({ message: '' });

  assert.equal(browserError.message, 'proxy disconnected');
  assert.equal(genericError.message, 'WebSocket error');
  assert.equal(Reflect.get(browserError, 'llmCode'), 'llm_connection_lost');
  assert.equal(Reflect.get(genericError, 'llmCode'), 'llm_connection_lost');
});

void test('WebSocket close extraction preserves string, binary, and unstructured reasons', () => {
  const abnormalClose = extractWebSocketCloseError({
    code: 1006,
    reason: 'abnormal close',
  });

  assert.equal(abnormalClose.message, 'WebSocket closed 1006 abnormal close');
  assert.equal(Reflect.get(abnormalClose, 'llmCode'), 'llm_connection_lost');
  assert.equal(
    extractWebSocketCloseError({
      reason: new TextEncoder().encode('maintenance'),
    }).message,
    'WebSocket closed maintenance',
  );
  assert.equal(
    extractWebSocketCloseError({ code: 1000, reason: '' }).message,
    'WebSocket closed 1000',
  );
  assert.equal(
    extractWebSocketCloseError({ code: 1000 }).message,
    'WebSocket closed 1000',
  );
  assert.equal(
    extractWebSocketCloseError(undefined).message,
    'WebSocket closed',
  );
});

void test('resolveResponsesStreamIdleTimeoutMs preserves the normative 60-second default', () => {
  assert.equal(resolveResponsesStreamIdleTimeoutMs({}), 60_000);
});

void test('resolveResponsesStreamIdleTimeoutMs accepts an explicit positive operator value', () => {
  assert.equal(
    resolveResponsesStreamIdleTimeoutMs({
      GEULBAT_LLM_STREAM_IDLE_TIMEOUT_MS: '300000',
    }),
    300_000,
  );
});

void test('resolveResponsesStreamIdleTimeoutMs rejects malformed operator values', () => {
  for (const value of ['0', '-1', '1.5', 'not-a-number']) {
    assert.throws(
      () =>
        resolveResponsesStreamIdleTimeoutMs({
          GEULBAT_LLM_STREAM_IDLE_TIMEOUT_MS: value,
        }),
      /GEULBAT_LLM_STREAM_IDLE_TIMEOUT_MS must be a positive safe integer/u,
    );
  }
});

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
      kind: 'backend_item',
      data: {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'opaque-reasoning',
      },
    },
    {
      kind: 'backend_item',
      data: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"hello.txt"}',
      },
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
      id: 'rs_1',
      type: 'reasoning',
      encrypted_content: 'opaque-reasoning',
    },
    {
      id: 'fc_1',
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

void test('streamResponsesOverWebSocket rejects incompatible native history before acquiring a socket', async () => {
  let acquireCalls = 0;
  await assert.rejects(
    streamResponsesOverWebSocket({
      body: baseBody,
      headers: new Headers(),
      historyProjection: 'provider_output',
      history: [
        {
          kind: 'provider_native_compaction',
          providerId: 'openai_codex_direct',
          model: 'different-model',
          output: [
            {
              type: 'compaction',
              encrypted_content: 'opaque-checkpoint',
            },
          ],
        },
      ],
      providerSessionId: 'provider-session',
      webSocketReusePolicy: TEST_REUSE_POLICY,
      providerWebSocketSessions: {
        async acquireWebSocket() {
          acquireCalls += 1;
          throw new Error('socket must not be acquired');
        },
      },
    }),
    /provider-native compaction history is incompatible/u,
  );
  assert.equal(acquireCalls, 0);
});

void test('streamResponsesOverWebSocket can emit sanitized discovery snapshots without changing parse behavior', async () => {
  const sentPayloads: string[] = [];
  const discoveryRequests: unknown[] = [];
  const discoveryEvents: unknown[] = [];
  let acquiredHeaders: Headers | undefined;
  let acquiredReusePolicy: ResponsesWebSocketReusePolicy | undefined;
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
    historyProjection: 'provider_output',
    history: [{ kind: 'user', text: 'private user text' }],
    providerSessionId: 'session-secret',
    webSocketReusePolicy: TEST_REUSE_POLICY,
    providerWebSocketSessions: {
      async acquireWebSocket(
        _url,
        headers,
        _providerSessionId,
        webSocketReusePolicy,
      ) {
        acquiredHeaders = headers;
        acquiredReusePolicy = webSocketReusePolicy;
        return {
          socket,
          reused: false,
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
  assert.equal(
    acquiredHeaders?.get('OpenAI-Beta'),
    'responses_websockets=2026-02-06',
  );
  assert.deepEqual(acquiredReusePolicy, TEST_REUSE_POLICY);
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

void test('streamResponsesOverWebSocket reconnects a stale reused socket before dispatch without losing conversation context', async () => {
  const sentPayloads: string[] = [];
  const releases: boolean[] = [];
  let acquireCalls = 0;
  let staleSendCalls = 0;
  const staleSocket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send(payload: string): void;
    close(code?: number, reason?: string): void;
  };
  staleSocket.readyState = 3;
  staleSocket.send = () => {
    staleSendCalls += 1;
    throw new Error('stale socket must be replaced before dispatch');
  };
  staleSocket.close = () => {};

  const freshSocket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send(payload: string): void;
    close(code?: number, reason?: string): void;
  };
  freshSocket.readyState = 1;
  freshSocket.send = (payload: string) => {
    sentPayloads.push(payload);
  };
  freshSocket.close = () => {};

  const history = [
    { kind: 'user', text: '첫 질문' },
    { kind: 'assistant', phase: 'final_answer', text: '첫 답변' },
    { kind: 'user', text: '잠시 쉬었다가 이어서 묻는 질문' },
  ] as const;
  const runPromise = streamResponsesOverWebSocket({
    body: baseBody,
    headers: new Headers(),
    historyProjection: 'provider_output',
    history: [...history],
    providerSessionId: 'provider-session',
    webSocketReusePolicy: TEST_REUSE_POLICY,
    providerWebSocketSessions: {
      async acquireWebSocket() {
        acquireCalls += 1;
        return acquireCalls === 1
          ? {
              socket: staleSocket,
              reused: true,
              release({ keep } = {}) {
                releases.push(keep === true);
              },
            }
          : {
              socket: freshSocket,
              reused: false,
              release({ keep } = {}) {
                releases.push(keep === true);
              },
            };
      },
    },
  });

  await setImmediatePromise();
  freshSocket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.output_item.added',
        item: { id: 'item-1', type: 'message', phase: 'final_answer' },
      }),
    ),
  );
  freshSocket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.output_text.delta',
        item_id: 'item-1',
        delta: '이어진 답변',
      }),
    ),
  );
  freshSocket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'item-1',
          type: 'message',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '이어진 답변' }],
        },
      }),
    ),
  );
  freshSocket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 1 } },
      }),
    ),
  );

  const result = await runPromise;

  assert.equal(result.finalText, '이어진 답변');
  assert.equal(acquireCalls, 2);
  assert.equal(staleSendCalls, 0);
  assert.deepEqual(releases, [false, true]);
  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(
    JSON.parse(sentPayloads[0] ?? '{}'),
    buildResponseCreatePayload(baseBody, [...history]),
  );
});

function setImmediatePromise(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
