import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactGrokHistory,
  compactOpenAiHistory,
  resolveGrokNativeCompactionPolicy,
  resolveOpenAiNativeCompactionPolicy,
  type OpenAiNativeCompactionInput,
  type ProviderNativeCompactionInput,
} from './provider-native-compaction.js';
import { createProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from './provider-options.js';
import { createProviderReplayScopeId } from './provider-replay-scope.js';
import { resolveCodexResponsesUrl } from './transport/responses-websocket-url.js';

const defaultProviderRequestOptions: ProviderRequestOptions =
  resolveProviderRequestOptions({});

function createOpenAiNativeCompactionInput(
  overrides: Partial<OpenAiNativeCompactionInput> = {},
): OpenAiNativeCompactionInput {
  return {
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    tools: [
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    providerSessionId: 'provider-session',
    providerWebSocketSessions: {
      acquireWebSocket: () => {
        throw new Error('not used');
      },
    },
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      model: 'gpt-test',
    },
    ...overrides,
  };
}

function createGrokNativeCompactionInput(
  overrides: Partial<ProviderNativeCompactionInput> = {},
): ProviderNativeCompactionInput {
  return {
    ...createOpenAiNativeCompactionInput(),
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      providerId: 'grok_oauth',
      model: 'grok-4.5',
    },
    ...overrides,
  };
}

void test('resolveOpenAiNativeCompactionPolicy derives the upstream-compatible threshold from the OAuth catalog', async () => {
  const input = createOpenAiNativeCompactionInput();
  const policy = await resolveOpenAiNativeCompactionPolicy(input, {
    getProviderAuth: async () => ({
      accessToken: 'token',
      accountId: 'account',
    }),
    forceRefreshProviderAuth: async () => ({
      accessToken: 'fresh-token',
      accountId: 'account',
    }),
    responsesUrl: 'https://chatgpt.test/backend-api/codex/responses',
    clientVersion: '1.2.3-test',
    fetchImpl: async (request, init) => {
      assert.equal(
        String(request),
        'https://chatgpt.test/backend-api/codex/models?client_version=1.2.3-test',
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer token');
      assert.equal(headers.get('chatgpt-account-id'), 'account');
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-test',
              context_window: 272_000,
              auto_compact_token_limit: null,
              supports_parallel_tool_calls: true,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  assert.deepEqual(policy, {
    providerId: 'openai_codex_direct',
    model: 'gpt-test',
    contextWindow: 272_000,
    thresholdTokens: 244_800,
    supportsParallelToolCalls: true,
  });
});

void test('resolveOpenAiNativeCompactionPolicy honors a lower catalog threshold', async () => {
  const input = createOpenAiNativeCompactionInput();
  const policy = await resolveOpenAiNativeCompactionPolicy(input, {
    getProviderAuth: async () => ({
      accessToken: 'token',
      accountId: 'account',
    }),
    forceRefreshProviderAuth: async () => ({
      accessToken: 'fresh-token',
      accountId: 'account',
    }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-test',
              context_window: 100_000,
              auto_compact_token_limit: 80_000,
              supports_parallel_tool_calls: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  assert.equal(policy.thresholdTokens, 80_000);
});

void test('compactOpenAiHistory retries OAuth once and preserves the opaque replacement without response ids', async () => {
  const input = createOpenAiNativeCompactionInput({
    promptContext: 'thread context',
    deferredTools: [
      {
        type: 'function',
        name: 'mcp_external_lookup',
        description: 'Look up an external record.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      model: 'gpt-test',
      serviceTier: 'fast',
    },
  });
  let forceRefreshCalls = 0;
  let requestCalls = 0;
  const result = await compactOpenAiHistory(
    input,
    {
      providerId: 'openai_codex_direct',
      model: 'gpt-test',
      contextWindow: 100_000,
      thresholdTokens: 90_000,
      supportsParallelToolCalls: true,
    },
    {
      getProviderAuth: async (options) => {
        assert.equal(
          options.allowRefresh,
          requestCalls > 0 ? false : undefined,
        );
        return {
          accessToken: forceRefreshCalls > 0 ? 'fresh-token' : 'token',
          accountId: 'account',
        };
      },
      forceRefreshProviderAuth: async () => {
        forceRefreshCalls += 1;
        return {
          accessToken: 'fresh-token',
          accountId: 'account',
        };
      },
      fetchImpl: globalThis.fetch,
      responsesUrl: 'https://chatgpt.test/backend-api/codex/responses',
      compactionFetchImpl: async (request, init) => {
        requestCalls += 1;
        assert.equal(
          String(request),
          'https://chatgpt.test/backend-api/codex/responses/compact',
        );
        if (requestCalls === 1) {
          return new Response(null, { status: 401 });
        }
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer fresh-token');
        assert.equal(headers.get('accept'), 'application/json');
        assert.equal(typeof init?.body, 'string');
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        assert.equal(body['model'], 'gpt-test');
        assert.equal(body['instructions'], 'system\n\nthread context');
        assert.equal(body['parallel_tool_calls'], true);
        assert.equal(body['service_tier'], 'priority');
        assert.equal(body['prompt_cache_key'], 'provider-session');
        assert.deepEqual(body['input'], [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ]);
        assert.deepEqual(body['reasoning'], {
          effort: 'medium',
          summary: 'auto',
        });
        assert.deepEqual(body['tools'], [
          input.tools?.[0],
          {
            ...input.deferredTools?.[0],
            defer_loading: true,
          },
          { type: 'tool_search' },
        ]);
        return new Response(
          JSON.stringify({
            output: [
              {
                id: 'response-item-id',
                type: 'compaction',
                encrypted_content: 'opaque-checkpoint',
              },
              {
                id: 'message-id',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'replacement' }],
              },
            ],
            usage: {
              input_tokens: 139,
              output_tokens: 438,
              input_tokens_details: { cached_tokens: 64 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );

  assert.equal(forceRefreshCalls, 1);
  assert.equal(requestCalls, 2);
  assert.deepEqual(result.output, [
    {
      type: 'compaction',
      encrypted_content: 'opaque-checkpoint',
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'replacement' }],
    },
  ]);
  assert.deepEqual(result.providerUsageTelemetry, {
    inputTokens: 139,
    outputTokens: 438,
    cachedInputTokens: 64,
  });
  assert.equal(
    result.providerReplayScopeId,
    createProviderReplayScopeId({
      providerId: 'openai_codex_direct',
      accountId: 'account',
      endpoint: 'https://chatgpt.test/backend-api/codex/responses',
    }),
  );
});

void test('compactOpenAiHistory accepts the live OAuth compaction_summary window without pruning retained items', async () => {
  const input = createOpenAiNativeCompactionInput();
  const result = await compactOpenAiHistory(
    input,
    {
      providerId: 'openai_codex_direct',
      model: 'gpt-test',
      contextWindow: 100_000,
      thresholdTokens: 90_000,
      supportsParallelToolCalls: true,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'fresh-token',
        accountId: 'account',
      }),
      fetchImpl: globalThis.fetch,
      compactionFetchImpl: async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                id: 'retained-user-id',
                type: 'message',
                role: 'user',
                status: 'completed',
                content: [{ type: 'input_text', text: 'hello' }],
              },
              {
                id: 'compaction-summary-id',
                type: 'compaction_summary',
                encrypted_content: 'opaque-checkpoint',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    },
  );

  assert.deepEqual(result.output, [
    {
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [{ type: 'input_text', text: 'hello' }],
    },
    {
      type: 'compaction_summary',
      encrypted_content: 'opaque-checkpoint',
    },
  ]);
  assert.equal(
    result.providerReplayScopeId,
    createProviderReplayScopeId({
      providerId: 'openai_codex_direct',
      accountId: 'account',
      endpoint: resolveCodexResponsesUrl(),
    }),
  );
});

void test('resolveGrokNativeCompactionPolicy derives the approved Grok Build threshold from the live model descriptor', async () => {
  const input = createGrokNativeCompactionInput({
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      providerId: 'grok_oauth',
      model: 'grok',
    },
  });
  const policy = await resolveGrokNativeCompactionPolicy(input, {
    getProviderAuth: async (options) => {
      assert.equal(options.providerId, 'grok_oauth');
      assert.equal(options.allowRefresh, undefined);
      return { accessToken: 'token', accountId: '' };
    },
    forceRefreshProviderAuth: async () => ({
      accessToken: 'fresh-token',
      accountId: '',
    }),
    fetchImpl: async (request, init) => {
      assert.equal(String(request), 'https://api.x.ai/v1/models/grok-4.5');
      assert.equal(init?.method, 'GET');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer token');
      assert.equal(headers.get('accept'), 'application/json');
      return new Response(
        JSON.stringify({ id: 'grok-4.5', context_length: 500_000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  assert.deepEqual(policy, {
    providerId: 'grok_oauth',
    model: 'grok-4.5',
    contextWindow: 500_000,
    thresholdTokens: 425_000,
  });
});

void test('resolveGrokNativeCompactionPolicy fails closed on an invalid model context', async () => {
  await assert.rejects(
    resolveGrokNativeCompactionPolicy(createGrokNativeCompactionInput(), {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: '',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'fresh-token',
        accountId: '',
      }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ id: 'grok-4.5', context_length: '500000' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    }),
    /invalid context length/u,
  );
});

void test('compactGrokHistory retries OAuth once and preserves the xAI opaque output verbatim', async () => {
  const input = createGrokNativeCompactionInput({
    history: [
      {
        kind: 'provider_native_compaction',
        providerId: 'grok_oauth',
        model: 'grok-4.5',
        output: [
          {
            id: 'previous-compaction-id',
            type: 'compaction',
            encrypted_content: 'previous-opaque-checkpoint',
          },
        ],
      },
      { kind: 'user', text: 'continue' },
    ],
    promptContext: 'thread context',
  });
  let forceRefreshCalls = 0;
  let requestCalls = 0;
  const result = await compactGrokHistory(
    input,
    {
      providerId: 'grok_oauth',
      model: 'grok-4.5',
      contextWindow: 500_000,
      thresholdTokens: 425_000,
    },
    {
      getProviderAuth: async (options) => {
        assert.equal(options.providerId, 'grok_oauth');
        assert.equal(
          options.allowRefresh,
          requestCalls > 0 ? false : undefined,
        );
        return {
          accessToken: forceRefreshCalls > 0 ? 'fresh-token' : 'token',
          accountId: 'grok-account',
        };
      },
      forceRefreshProviderAuth: async (options) => {
        assert.equal(options.providerId, 'grok_oauth');
        forceRefreshCalls += 1;
        return { accessToken: 'fresh-token', accountId: 'grok-account' };
      },
      fetchImpl: globalThis.fetch,
      compactionFetchImpl: async (request, init) => {
        requestCalls += 1;
        assert.equal(String(request), 'https://api.x.ai/v1/responses/compact');
        assert.equal(init?.method, 'POST');
        if (requestCalls === 1) {
          return new Response(null, { status: 401 });
        }
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer fresh-token');
        assert.equal(headers.get('accept'), 'application/json');
        assert.equal(headers.get('content-type'), 'application/json');
        assert.equal(typeof init?.body, 'string');
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        assert.deepEqual(Object.keys(body).sort(), ['input', 'model']);
        assert.equal(body['model'], 'grok-4.5');
        assert.deepEqual(body['input'], [
          { role: 'system', content: 'system\n\nthread context' },
          {
            id: 'previous-compaction-id',
            type: 'compaction',
            encrypted_content: 'previous-opaque-checkpoint',
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'continue' }],
          },
        ]);
        return new Response(
          JSON.stringify({
            output: [
              {
                id: 'xai-compaction-id',
                type: 'compaction',
                encrypted_content: 'new-opaque-checkpoint',
              },
            ],
            usage: {
              input_tokens: 211,
              output_tokens: 55,
              input_tokens_details: { cached_tokens: 17 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );

  assert.equal(forceRefreshCalls, 1);
  assert.equal(requestCalls, 2);
  assert.deepEqual(result.output, [
    {
      id: 'xai-compaction-id',
      type: 'compaction',
      encrypted_content: 'new-opaque-checkpoint',
    },
  ]);
  assert.deepEqual(result.providerUsageTelemetry, {
    inputTokens: 211,
    outputTokens: 55,
    cachedInputTokens: 17,
  });
  assert.equal(
    result.providerReplayScopeId,
    createProviderReplayScopeId({
      providerId: 'grok_oauth',
      accountId: 'grok-account',
      endpoint: 'https://api.x.ai/v1',
    }),
  );
});

void test('compactOpenAiHistory replays durable auth attempts after replacement without another provider dispatch', async () => {
  const serializedPayloadByAttempt = new Map<number, string>();
  const dispatchedAttempts = new Set<number>();
  const subscribedAttempts: number[] = [];
  let providerDispatches = 0;
  const input = createOpenAiNativeCompactionInput({
    providerWebSocketSessions: {
      acquireWebSocket: () => {
        throw new Error('not used');
      },
      streamDurableHttpSseEvents: async function* (request) {
        subscribedAttempts.push(request.requestAttempt);
        assert.equal(
          request.providerSessionId,
          'provider-native-compaction:provider-session',
        );
        assert.equal(
          request.requestUrl,
          'https://chatgpt.test/backend-api/codex/responses/compact',
        );
        const admittedPayload = serializedPayloadByAttempt.get(
          request.requestAttempt,
        );
        if (admittedPayload === undefined) {
          serializedPayloadByAttempt.set(
            request.requestAttempt,
            request.serializedPayload,
          );
        } else {
          assert.equal(request.serializedPayload, admittedPayload);
        }
        if (!dispatchedAttempts.has(request.requestAttempt)) {
          dispatchedAttempts.add(request.requestAttempt);
          providerDispatches += 1;
        }
        if (request.requestAttempt === 0) {
          throw Object.assign(new Error('expired token'), { status: 401 });
        }
        yield {
          output: [
            {
              id: 'openai-compaction-id',
              type: 'compaction',
              encrypted_content: 'durable-openai-checkpoint',
            },
          ],
          usage: { input_tokens: 101, output_tokens: 20 },
        };
      },
    },
  });
  const policy = {
    providerId: 'openai_codex_direct' as const,
    model: 'gpt-test',
    contextWindow: 100_000,
    thresholdTokens: 90_000,
    supportsParallelToolCalls: true,
  };
  let forceRefreshCalls = 0;
  const deps = {
    getProviderAuth: async (options: { allowRefresh?: boolean }) => ({
      accessToken:
        options.allowRefresh === false ? 'fresh-token' : 'expired-token',
      accountId: 'account',
    }),
    forceRefreshProviderAuth: async () => {
      forceRefreshCalls += 1;
      return { accessToken: 'fresh-token', accountId: 'account' };
    },
    fetchImpl: globalThis.fetch,
    responsesUrl: 'https://chatgpt.test/backend-api/codex/responses',
  };

  const first = await compactOpenAiHistory(input, policy, deps);
  const replacement = await compactOpenAiHistory(input, policy, deps);

  assert.equal(providerDispatches, 2);
  assert.deepEqual(subscribedAttempts, [0, 1, 0, 1]);
  assert.equal(forceRefreshCalls, 2);
  assert.deepEqual(replacement, first);
  assert.deepEqual(replacement.output, [
    {
      type: 'compaction',
      encrypted_content: 'durable-openai-checkpoint',
    },
  ]);
});

void test('compactGrokHistory replays one durable terminal response after replacement', async () => {
  let admittedPayload: string | undefined;
  let providerDispatches = 0;
  let durableSubscriptions = 0;
  const input = createGrokNativeCompactionInput({
    providerWebSocketSessions: {
      acquireWebSocket: () => {
        throw new Error('not used');
      },
      streamDurableHttpSseEvents: async function* (request) {
        durableSubscriptions += 1;
        assert.equal(
          request.providerSessionId,
          'provider-native-compaction:provider-session',
        );
        assert.equal(
          request.requestUrl,
          'https://api.x.ai/v1/responses/compact',
        );
        assert.equal(request.requestAttempt, 0);
        if (admittedPayload === undefined) {
          admittedPayload = request.serializedPayload;
          providerDispatches += 1;
        } else {
          assert.equal(request.serializedPayload, admittedPayload);
        }
        yield {
          output: [
            {
              id: 'grok-compaction-id',
              type: 'compaction',
              encrypted_content: 'durable-grok-checkpoint',
            },
          ],
          usage: { input_tokens: 88, output_tokens: 12 },
        };
      },
    },
  });
  const policy = {
    providerId: 'grok_oauth' as const,
    model: 'grok-4.5',
    contextWindow: 500_000,
    thresholdTokens: 425_000,
  };
  const deps = {
    getProviderAuth: async () => ({
      accessToken: 'token',
      accountId: 'grok-account',
    }),
    forceRefreshProviderAuth: async () => ({
      accessToken: 'fresh-token',
      accountId: 'grok-account',
    }),
    fetchImpl: globalThis.fetch,
  };

  const first = await compactGrokHistory(input, policy, deps);
  const replacement = await compactGrokHistory(input, policy, deps);

  assert.equal(providerDispatches, 1);
  assert.equal(durableSubscriptions, 2);
  assert.deepEqual(replacement, first);
  assert.deepEqual(replacement.output, [
    {
      id: 'grok-compaction-id',
      type: 'compaction',
      encrypted_content: 'durable-grok-checkpoint',
    },
  ]);
});

void test('compactOpenAiHistory fails closed when the durable POST owner is unavailable', async () => {
  let directFetchCalls = 0;
  await assert.rejects(
    compactOpenAiHistory(
      createOpenAiNativeCompactionInput(),
      {
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        contextWindow: 100_000,
        thresholdTokens: 90_000,
        supportsParallelToolCalls: true,
      },
      {
        getProviderAuth: async () => ({
          accessToken: 'token',
          accountId: 'account',
        }),
        forceRefreshProviderAuth: async () => ({
          accessToken: 'fresh-token',
          accountId: 'account',
        }),
        fetchImpl: async () => {
          directFetchCalls += 1;
          throw new Error('must not use the policy GET client for POST');
        },
      },
    ),
    /durable provider-native compaction transport is unavailable/u,
  );
  assert.equal(directFetchCalls, 0);
});
