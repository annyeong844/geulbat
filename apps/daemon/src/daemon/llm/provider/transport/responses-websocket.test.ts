import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildResponseCreatePayload } from './responses-wire-input.js';
import {
  extractWebSocketCloseError,
  extractWebSocketError,
} from './responses-websocket-errors.js';
import { connectWebSocket } from './responses-websocket-connection.js';
import {
  resolveCodexResponsesUrl,
  resolveCodexWebSocketUrl,
} from './responses-websocket-url.js';
import {
  resolveResponsesStreamIdleTimeoutMs,
  streamResponsesOverWebSocket,
  type ResponsesRequestMeasurement,
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

void test('WebSocket error extraction preserves authentication handshake failures', () => {
  for (const status of [401, 403]) {
    const error = extractWebSocketError(
      new Error(`Unexpected server response: ${status}`),
    );

    assert.equal(error.message, `Unexpected server response: ${status}`);
    assert.equal(Reflect.get(error, 'status'), status);
    assert.equal(Reflect.get(error, 'llmCode'), 'llm_auth_failed');
  }

  const upstreamFailure = extractWebSocketError(
    new Error('Unexpected server response: 500'),
  );
  assert.equal(Reflect.get(upstreamFailure, 'llmCode'), 'llm_connection_lost');
});

void test('WebSocket error extraction stops retrying certificate verification failures', () => {
  // 로컬에서 자가서명 인증서로 확인한 실제 형태다. `ws`의 error 이벤트가
  // Node의 구조화된 코드를 그대로 넘긴다.
  const certificateFailure = extractWebSocketError(
    Object.assign(
      new Error(
        'self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca',
      ),
      { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    ),
  );

  assert.equal(
    Reflect.get(certificateFailure, 'llmCode'),
    'llm_tls_verification_failed',
  );
  // 원문 메시지는 진단용으로 보존한다.
  assert.match(certificateFailure.message, /self-signed certificate/u);

  // 전송 중 TLS alert은 일시적 장애이므로 재시도 가능한 연결 유실로 남는다.
  const transientAlert = extractWebSocketError(
    Object.assign(new Error('write EPROTO ... ssl alert bad record mac'), {
      code: 'EPROTO',
    }),
  );
  assert.equal(Reflect.get(transientAlert, 'llmCode'), 'llm_connection_lost');
});

void test('WebSocket handshake rejection preserves provider Retry-After evidence', async () => {
  const server = createServer();
  server.on('upgrade', (_request, socket) => {
    socket.end(
      'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nConnection: close\r\n\r\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  try {
    await assert.rejects(
      connectWebSocket(`ws://127.0.0.1:${address.port}`, new Headers()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Unexpected server response: 429');
        assert.equal(Reflect.get(error, 'status'), 429);
        assert.equal(Reflect.get(error, 'retryAfterMs'), 2_000);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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

void test('resolveResponsesStreamIdleTimeoutMs leaves long reasoning unconstrained unless the operator opts in', () => {
  assert.equal(resolveResponsesStreamIdleTimeoutMs({}), undefined);
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

void test('streamResponsesOverWebSocket selects the stable request owner without direct-socket fallback', async () => {
  let durableCalls = 0;
  let directSocketCalls = 0;
  const providerWebSocketSessions = {
    async acquireWebSocket() {
      directSocketCalls += 1;
      throw new Error('direct socket path must not run');
    },
    async *streamDurableResponseEvents(input: {
      serializedPayload: string;
    }): AsyncIterable<Record<string, unknown>> {
      durableCalls += 1;
      assert.match(input.serializedPayload, /"type":"response.create"/u);
      yield {
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 0 } },
      };
    },
  };

  await streamResponsesOverWebSocket({
    body: baseBody,
    headers: new Headers({ Authorization: 'Bearer private-token' }),
    historyProjection: 'provider_output',
    history: [],
    providerSessionId: 'provider-session',
    webSocketReusePolicy: TEST_REUSE_POLICY,
    providerWebSocketSessions,
  });

  assert.equal(durableCalls, 1);
  assert.equal(directSocketCalls, 0);
});

void test('streamResponsesOverWebSocket propagates stable-owner failure without direct-socket fallback', async () => {
  let directSocketCalls = 0;

  await assert.rejects(
    streamResponsesOverWebSocket({
      body: baseBody,
      headers: new Headers({ Authorization: 'Bearer private-token' }),
      historyProjection: 'provider_output',
      history: [],
      providerSessionId: 'provider-session',
      webSocketReusePolicy: TEST_REUSE_POLICY,
      providerWebSocketSessions: {
        async acquireWebSocket() {
          directSocketCalls += 1;
          throw new Error('direct socket path must not run');
        },
        async *streamDurableResponseEvents(): AsyncIterable<
          Record<string, unknown>
        > {
          throw new Error('stable owner unavailable');
        },
      },
    }),
    /stable owner unavailable/u,
  );

  assert.equal(directSocketCalls, 0);
});

void test('streamResponsesOverWebSocket forwards provider Retry-After evidence to the shared session owner', async () => {
  const deferrals: Array<{ url: string; retryAfterMs: number }> = [];
  await assert.rejects(
    streamResponsesOverWebSocket({
      body: baseBody,
      headers: new Headers(),
      historyProjection: 'provider_output',
      history: [],
      providerSessionId: 'provider-session',
      webSocketUrl: 'wss://api.example.test/v1/responses',
      webSocketReusePolicy: TEST_REUSE_POLICY,
      providerWebSocketSessions: {
        async acquireWebSocket() {
          throw Object.assign(new Error('provider rate limited'), {
            status: 429,
            retryAfterMs: 2_500,
          });
        },
        deferProviderRequests(url, retryAfterMs) {
          deferrals.push({ url, retryAfterMs });
        },
      },
    }),
    /provider rate limited/u,
  );

  assert.deepEqual(deferrals, [
    {
      url: 'wss://api.example.test/v1/responses',
      retryAfterMs: 2_500,
    },
  ]);
});

void test('streamResponsesOverWebSocket measures the exact serialized request immediately before dispatch', async () => {
  const order: string[] = [];
  const admissionStates: string[] = [];
  const requestText = 'UTF-8 한글 요청'.repeat(64);
  let sentPayload = '';
  let measurement: ResponsesRequestMeasurement | undefined;
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send(payload: string): void;
    close(code?: number, reason?: string): void;
  };
  socket.readyState = 1;
  socket.send = (payload: string) => {
    order.push('send');
    sentPayload = payload;
  };
  socket.close = () => {};

  const runPromise = streamResponsesOverWebSocket({
    payload: {
      type: 'response.create',
      model: 'test-model',
      input: [{ role: 'user', content: requestText }],
    },
    headers: new Headers(),
    historyProjection: 'provider_output',
    providerSessionId: 'provider-session',
    webSocketReusePolicy: TEST_REUSE_POLICY,
    providerWebSocketSessions: {
      async acquireWebSocket(
        _url,
        _headers,
        _providerSessionId,
        _reusePolicy,
        _signal,
        onAdmissionState,
      ) {
        onAdmissionState?.({ state: 'rate_limit_waiting' });
        onAdmissionState?.({ state: 'admitted' });
        return {
          socket,
          reused: false,
          release() {},
        };
      },
    },
    onRequestPrepared(nextMeasurement) {
      order.push('measure');
      measurement = nextMeasurement;
    },
    onAdmissionState(observation) {
      admissionStates.push(observation.state);
    },
  });

  await setImmediatePromise();
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 1 } },
      }),
    ),
  );
  await runPromise;

  assert.deepEqual(order, ['measure', 'send']);
  assert.deepEqual(admissionStates, ['rate_limit_waiting', 'admitted']);
  assert.equal(
    measurement?.serializedBytes,
    Buffer.byteLength(sentPayload, 'utf8'),
  );
  assert.equal(measurement?.dominantPressureSource, 'history');
  assert.ok((measurement?.serializedBytesBySource.history ?? 0) > 0);
  assert.ok(sentPayload.includes(requestText));
});

void test('streamResponsesOverWebSocket stops a request before socket acquisition when preparation is required', async () => {
  let acquireCalls = 0;

  await assert.rejects(
    streamResponsesOverWebSocket({
      body: baseBody,
      history: [{ kind: 'user', text: 'prepare first' }],
      headers: new Headers(),
      historyProjection: 'normalized',
      providerSessionId: 'thread-preparation',
      webSocketReusePolicy: TEST_REUSE_POLICY,
      providerWebSocketSessions: {
        async acquireWebSocket() {
          acquireCalls += 1;
          throw new Error('socket acquisition must not run');
        },
      },
      onRequestPrepared() {
        return { kind: 'prepare', reason: 'over_window' };
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      Reflect.get(error, 'llmCode') === 'llm_context_preparation_required' &&
      Reflect.get(error, 'preparationReason') === 'over_window',
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
