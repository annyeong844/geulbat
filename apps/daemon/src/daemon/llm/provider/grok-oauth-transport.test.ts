import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  GROK_OAUTH_PROVIDER_CACHE_PROFILE,
  GROK_OAUTH_RESPONSES_WEBSOCKET_REUSE_POLICY,
  buildGrokOAuthResponsesHeaders,
  buildGrokOAuthResponsesRequestBody,
  buildGrokOAuthResponsesWebSocketUrl,
  resolveGrokOAuthModelDescriptor,
  streamGrokOAuthResponses,
} from './grok-oauth-transport.js';
import type {
  ResponsesWebSocketReusePolicy,
  ResponsesWebSocketSessionSocket,
} from './transport/responses-websocket-cache.js';
import type { WireToolDefinition } from './wire/types.js';

void test('resolveGrokOAuthModelDescriptor maps accepted Grok model ids to the xAI Responses descriptor', () => {
  const model = resolveGrokOAuthModelDescriptor('grok-4.5');

  assert.equal(model.providerId, 'grok_oauth');
  assert.equal(model.id, 'grok-4.5');
  assert.equal(model.wireModel, 'grok-4.5');
  assert.equal(model.routeFamily, 'xai_public_responses');
  assert.equal(
    buildGrokOAuthResponsesWebSocketUrl(model),
    'wss://api.x.ai/v1/responses',
  );
});

void test('resolveGrokOAuthModelDescriptor maps the Grok alias to 4.5', () => {
  const model = resolveGrokOAuthModelDescriptor('grok');

  assert.equal(model.id, 'grok-4.5');
});

void test('resolveGrokOAuthModelDescriptor rejects unknown models', () => {
  assert.throws(
    () => resolveGrokOAuthModelDescriptor('not-a-grok-model'),
    /unknown Grok OAuth model/u,
  );
});

void test('buildGrokOAuthResponsesHeaders projects explicit OAuth bearer for standard xAI WebSocket', () => {
  const headers = buildGrokOAuthResponsesHeaders({
    accessToken: 'token',
  });

  assert.equal(headers.get('authorization'), 'Bearer token');
  assert.equal(headers.has('content-type'), false);
  assert.equal(headers.has('accept'), false);
  assert.equal(headers.has('openai-beta'), false);
  assert.equal(headers.has('x-grok-client-version'), false);
  assert.equal(headers.has('x-grok-client-identifier'), false);
  assert.equal(headers.has('x-grok-conv-id'), false);
});

void test('buildGrokOAuthResponsesHeaders rejects missing credentials at the provider boundary', () => {
  assert.throws(
    () =>
      buildGrokOAuthResponsesHeaders({
        accessToken: '  ',
      }),
    /accessToken is required/u,
  );
});

void test('buildGrokOAuthResponsesHeaders emits x-grok-conv-id only for an explicit operator probe', () => {
  const headers = buildGrokOAuthResponsesHeaders({
    accessToken: 'token',
    conversationRoutingId: 'probe-routing-id',
  });

  assert.equal(headers.get('x-grok-conv-id'), 'probe-routing-id');
});

void test('buildGrokOAuthResponsesRequestBody emits the live-verified thread cache projection', () => {
  const model = resolveGrokOAuthModelDescriptor('grok');
  const body = buildGrokOAuthResponsesRequestBody({
    model,
    providerSessionId: 'provider-session',
    history: [{ kind: 'user', text: 'hello' }],
    instructions: 'system',
    reasoningEffort: 'high',
  });

  assert.deepEqual(body, {
    model: 'grok-4.5',
    store: false,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
    instructions: 'system',
    prompt_cache_key: 'provider-session',
    reasoning: { effort: 'high' },
  });
  assert.equal(Object.hasOwn(body, 'stream'), false);
  assert.equal(body.prompt_cache_key, 'provider-session');
  assert.equal(Object.hasOwn(body, 'cache_control'), false);
});

void test('buildGrokOAuthResponsesRequestBody includes tools with the thread cache projection', () => {
  const model = resolveGrokOAuthModelDescriptor('grok');
  const tools: WireToolDefinition[] = [
    {
      type: 'function',
      name: 'get_weather',
      description: 'Read weather',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
  const body = buildGrokOAuthResponsesRequestBody({
    model,
    providerSessionId: 'provider-session',
    history: [],
    tools,
    reasoningEffort: 'medium',
  });

  assert.equal(body.model, 'grok-4.5');
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.equal(body.tools, tools);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.prompt_cache_key, 'provider-session');
});

void test('buildGrokOAuthResponsesRequestBody replays matching native compaction output without pruning it', () => {
  const body = buildGrokOAuthResponsesRequestBody({
    model: resolveGrokOAuthModelDescriptor('grok'),
    providerSessionId: 'provider-session',
    history: [
      {
        kind: 'provider_native_compaction',
        providerId: 'grok_oauth',
        model: 'grok-4.5',
        output: [
          {
            id: 'xai-compaction-id',
            type: 'compaction',
            encrypted_content: 'opaque-checkpoint',
          },
        ],
      },
    ],
    reasoningEffort: 'medium',
  });

  assert.deepEqual(body.input, [
    {
      id: 'xai-compaction-id',
      type: 'compaction',
      encrypted_content: 'opaque-checkpoint',
    },
  ]);
});

void test('buildGrokOAuthResponsesRequestBody honors an explicit disabled cache intent', () => {
  const body = buildGrokOAuthResponsesRequestBody({
    model: resolveGrokOAuthModelDescriptor('grok'),
    providerSessionId: 'provider-session',
    history: [{ kind: 'user', text: 'hello' }],
    reasoningEffort: 'low',
    promptCacheIntent: {
      scope: 'disabled',
    },
  });

  assert.equal(Object.hasOwn(body, 'prompt_cache_key'), false);
});

void test('buildGrokOAuthResponsesRequestBody rejects unsupported reasoning effort', () => {
  assert.throws(
    () =>
      buildGrokOAuthResponsesRequestBody({
        model: resolveGrokOAuthModelDescriptor('grok'),
        providerSessionId: 'provider-session',
        history: [],
        reasoningEffort: 'max',
      }),
    /does not support 'max' reasoning effort/u,
  );
});

void test('GROK_OAUTH_PROVIDER_CACHE_PROFILE records the live-verified thread scope', () => {
  assert.deepEqual(GROK_OAUTH_PROVIDER_CACHE_PROFILE, {
    control: 'prompt_cache_key',
    observedBehavior: 'none',
    telemetry: 'observed_cached_input_tokens',
    verification: 'live_probe_verified',
    defaultScope: 'thread',
  });
});

void test('streamGrokOAuthResponses performs the xAI Responses WebSocket provider path', async () => {
  const model = resolveGrokOAuthModelDescriptor('grok');
  const deltas: string[] = [];
  const observed = createObservedWebSocketRun();

  const resultPromise = streamGrokOAuthResponses(
    {
      model,
      accessToken: 'access-token',
      providerSessionId: 'provider-session',
      history: [{ kind: 'user', text: 'hello' }],
      instructions: 'system',
      reasoningEffort: 'high',
      providerWebSocketSessions: observed.providerWebSocketSessions,
    },
    {
      onAssistantDelta: (delta) => deltas.push(delta.text),
    },
  );

  await setImmediatePromise();
  observed.emit({
    type: 'response.output_item.added',
    item: { id: 'msg_1', type: 'message' },
  });
  observed.emit({
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    delta: 'hello ',
  });
  observed.emit({
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    delta: 'world',
  });
  observed.emit({
    type: 'response.output_item.done',
    item: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hello world' }],
    },
  });
  observed.emit({
    type: 'response.done',
    response: {},
  });
  observed.emit({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 3 },
      },
    },
  });

  const result = await resultPromise;

  assert.equal(observed.url, 'wss://api.x.ai/v1/responses');
  assert.equal(observed.headers?.get('authorization'), 'Bearer access-token');
  assert.equal(observed.headers?.has('openai-beta'), false);
  assert.equal(observed.providerSessionId, 'provider-session');
  assert.deepEqual(
    observed.webSocketReusePolicy,
    GROK_OAUTH_RESPONSES_WEBSOCKET_REUSE_POLICY,
  );
  assert.deepEqual(observed.webSocketReusePolicy, {
    idleRetentionMs: 25 * 60 * 1000,
    maxConnectionLifetimeMs: 25 * 60 * 1000,
  });
  assert.deepEqual(
    observed.sentPayloads.map((payload) => JSON.parse(payload)),
    [
      {
        type: 'response.create',
        model: 'grok-4.5',
        store: false,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
        instructions: 'system',
        prompt_cache_key: 'provider-session',
        reasoning: { effort: 'high' },
      },
    ],
  );
  assert.deepEqual(deltas, ['hello ', 'world']);
  assert.equal(result.assistantText, 'hello world');
  assert.equal(result.finalText, 'hello world');
  assert.deepEqual(result.itemsToAppend, [
    {
      kind: 'backend_item',
      data: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello world' }],
      },
    },
  ]);
  assert.deepEqual(result.providerUsageTelemetry, {
    inputTokens: 11,
    outputTokens: 2,
    cachedInputTokens: 3,
  });
  assert.equal(observed.releaseKeep, true);
});

void test('streamGrokOAuthResponses preserves reasoning and function-call items as one provider batch', async () => {
  const model = resolveGrokOAuthModelDescriptor('grok');
  const observed = createObservedWebSocketRun();
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
  const resultPromise = streamGrokOAuthResponses(
    {
      model,
      accessToken: 'access-token',
      providerSessionId: 'provider-session',
      history: [{ kind: 'user', text: 'read it' }],
      reasoningEffort: 'high',
      providerWebSocketSessions: observed.providerWebSocketSessions,
    },
    {},
  );

  await setImmediatePromise();
  observed.emit({
    type: 'response.output_item.done',
    output_index: 0,
    item: reasoningItem,
  });
  observed.emit({
    type: 'response.output_item.done',
    output_index: 1,
    item: functionCallItem,
  });
  observed.emit({ type: 'response.completed', response: {} });

  const result = await resultPromise;
  assert.deepEqual(result.itemsToAppend, [
    { kind: 'backend_item', data: reasoningItem },
    { kind: 'backend_item', data: functionCallItem },
  ]);
  assert.deepEqual(result.functionCalls, [
    {
      id: 'fc_1',
      callId: 'call_1',
      name: 'read_file',
      arguments: '{"path":"README.md"}',
    },
  ]);
});

void test('streamGrokOAuthResponses surfaces xAI WebSocket error envelopes for retry owners', async () => {
  const model = resolveGrokOAuthModelDescriptor('grok');
  const observed = createObservedWebSocketRun();

  const resultPromise = streamGrokOAuthResponses(
    {
      model,
      accessToken: 'access-token',
      providerSessionId: 'provider-session',
      history: [],
      reasoningEffort: 'low',
      providerWebSocketSessions: observed.providerWebSocketSessions,
    },
    {},
  );

  await setImmediatePromise();
  observed.emit({
    type: 'error',
    status: 401,
    error: {
      code: 'unauthorized',
      message: 'expired token',
    },
  });

  await assert.rejects(resultPromise, /expired token/u);
  assert.equal(observed.releaseKeep, false);
});

interface ObservedWebSocketRun {
  providerWebSocketSessions: {
    acquireWebSocket: (
      url: string,
      headers: Headers,
      providerSessionId: string,
      webSocketReusePolicy: ResponsesWebSocketReusePolicy,
    ) => Promise<{
      socket: ResponsesWebSocketSessionSocket;
      reused: boolean;
      entry: {
        socket: ResponsesWebSocketSessionSocket;
        busy: boolean;
        idleTimer: undefined;
      };
      release: (options?: { keep?: boolean }) => void;
    }>;
  };
  sentPayloads: string[];
  emit(event: Record<string, unknown>): void;
  url?: string;
  headers?: Headers;
  providerSessionId?: string;
  webSocketReusePolicy?: ResponsesWebSocketReusePolicy;
  releaseKeep?: boolean;
}

function createObservedWebSocketRun(): ObservedWebSocketRun {
  const sentPayloads: string[] = [];
  const socket = new EventEmitter() as EventEmitter &
    ResponsesWebSocketSessionSocket;
  socket.readyState = 1;
  socket.send = (payload: string) => {
    sentPayloads.push(payload);
  };
  socket.close = () => {};

  const observed: ObservedWebSocketRun = {
    sentPayloads,
    emit(event: Record<string, unknown>) {
      socket.emit('message', Buffer.from(JSON.stringify(event)));
    },
    providerWebSocketSessions: {
      async acquireWebSocket(
        url: string,
        headers: Headers,
        providerSessionId: string,
        webSocketReusePolicy: ResponsesWebSocketReusePolicy,
      ) {
        observed.url = url;
        observed.headers = headers;
        observed.providerSessionId = providerSessionId;
        observed.webSocketReusePolicy = webSocketReusePolicy;
        return {
          socket,
          reused: false,
          entry: { socket, busy: true, idleTimer: undefined },
          release(options?: { keep?: boolean }) {
            observed.releaseKeep = options?.keep ?? false;
          },
        };
      },
    },
  };

  return observed;
}

function setImmediatePromise(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
