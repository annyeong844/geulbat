import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
  buildResponsesRequestHeaders,
  callModelWithDependencies,
  compactGrokHistory,
  compactOpenAiHistory,
  resolveGrokNativeCompactionPolicy,
  resolveOpenAiNativeCompactionPolicy,
  type OpenAiNativeCompactionInput,
  type ProviderNativeCompactionInput,
} from './client.js';
import { createProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from './provider-options.js';
import type { ResponsesWebSocketSessionStore } from './transport/responses-websocket-cache.js';

const unusedProviderWebSocketSessions: Pick<
  ResponsesWebSocketSessionStore,
  'acquireWebSocket'
> = {
  async acquireWebSocket() {
    throw new Error('provider websocket session store should not be used here');
  },
};

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

void test('buildResponsesRequestHeaders uses the current Codex direct originator', () => {
  const headers = buildResponsesRequestHeaders({
    accessToken: 'token',
    accountId: 'account',
    providerSessionId: 'provider-session',
  });

  assert.equal(headers.get('originator'), 'codex_cli_rs');
});

void test('callModelWithDependencies uses frozen provider request options instead of live env', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const previousModel = process.env.GEULBAT_CODEX_MODEL;
  const previousReasoningEffort = process.env.GEULBAT_CODEX_REASONING_EFFORT;
  const previousTextVerbosity = process.env.GEULBAT_CODEX_TEXT_VERBOSITY;
  process.env.GEULBAT_CODEX_MODEL = 'gpt-live-env';
  process.env.GEULBAT_CODEX_REASONING_EFFORT = 'xhigh';
  process.env.GEULBAT_CODEX_TEXT_VERBOSITY = 'high';

  try {
    const providerRequestOptions: ProviderRequestOptions = {
      ...defaultProviderRequestOptions,
      model: 'gpt-frozen-startup',
      text: { verbosity: 'low' },
      reasoning: { effort: 'low', summary: 'auto' },
    };
    const input = {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions,
    };
    const chunks = [];
    for await (const chunk of callModelWithDependencies(input, {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: async ({ body }) => {
        assert.ok(body);
        assert.equal(body.model, 'gpt-frozen-startup');
        assert.deepEqual(body.reasoning, {
          effort: 'low',
          summary: 'auto',
        });
        assert.deepEqual(body.text, { verbosity: 'low' });
        return {
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'ok',
          finalText: 'ok',
        };
      },
    })) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [
      {
        type: 'done',
        assistantText: 'ok',
        finalText: 'ok',
      },
    ]);
  } finally {
    if (previousModel === undefined) {
      delete process.env.GEULBAT_CODEX_MODEL;
    } else {
      process.env.GEULBAT_CODEX_MODEL = previousModel;
    }
    if (previousReasoningEffort === undefined) {
      delete process.env.GEULBAT_CODEX_REASONING_EFFORT;
    } else {
      process.env.GEULBAT_CODEX_REASONING_EFFORT = previousReasoningEffort;
    }
    if (previousTextVerbosity === undefined) {
      delete process.env.GEULBAT_CODEX_TEXT_VERBOSITY;
    } else {
      process.env.GEULBAT_CODEX_TEXT_VERBOSITY = previousTextVerbosity;
    }
  }
});

void test('callModelWithDependencies builds provider body from daemon-local provider request options', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const providerRequestOptions: ProviderRequestOptions = {
    ...defaultProviderRequestOptions,
    model: 'gpt-5.6-sol',
    reasoning: { effort: 'xhigh', summary: 'auto' },
    text: { verbosity: 'high' },
  };
  const chunks = [];
  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: async ({ body, webSocketReusePolicy }) => {
        assert.ok(body);
        assert.equal(body.model, 'gpt-5.6-sol');
        assert.equal(body.prompt_cache_key, 'provider-session');
        assert.deepEqual(
          webSocketReusePolicy,
          CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
        );
        assert.deepEqual(webSocketReusePolicy, {
          idleRetentionMs: 30 * 60 * 1000,
          maxConnectionLifetimeMs: 60 * 60 * 1000,
        });
        assert.deepEqual(body.reasoning, {
          effort: 'xhigh',
          summary: 'auto',
        });
        assert.deepEqual(body.text, { verbosity: 'high' });
        return {
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'ok',
          finalText: 'ok',
        };
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    {
      type: 'done',
      assistantText: 'ok',
      finalText: 'ok',
    },
  ]);
});

void test('callModelWithDependencies dispatches Grok OAuth through the provider transport path', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const chunks = [];
  const providerRequestOptions: ProviderRequestOptions = {
    ...defaultProviderRequestOptions,
    providerId: 'grok_oauth',
    model: 'grok-4.5',
    reasoning: { effort: 'high', summary: 'auto' },
  };
  const discoverySink = {
    recordRequest() {},
    recordEvent() {},
  };
  const observed: {
    accessToken?: string;
    authProviderId?: string;
    model?: string;
    history?: unknown[];
    instructions?: string;
    reasoningEffort?: string;
    discoverySink?: unknown;
    providerWebSocketSessions?: unknown;
  } = {};

  for await (const chunk of callModelWithDependencies(
    {
      history: [{ kind: 'user', text: 'hello' }],
      systemPrompt: 'system',
      promptContext: 'context',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions,
      oauthWireDiscoverySink: discoverySink,
    },
    {
      getProviderAuth: async (options) => {
        if (options.providerId !== undefined) {
          observed.authProviderId = options.providerId;
        }
        return {
          accessToken: 'grok-token',
          accountId: 'grok-account',
        };
      },
      forceRefreshProviderAuth: async () =>
        assert.fail('Grok auth refresh should not run on the happy path'),
      streamResponsesOverWebSocket: async () =>
        assert.fail('Codex websocket should not run'),
      streamGrokOAuthResponses: async (input, options) => {
        observed.accessToken = input.accessToken;
        observed.model = input.model.wireModel;
        observed.history = input.history;
        observed.providerWebSocketSessions = input.providerWebSocketSessions;
        observed.reasoningEffort = input.reasoningEffort;
        observed.discoverySink = input.discoverySink;
        if (input.instructions !== undefined) {
          observed.instructions = input.instructions;
        }
        options.onAssistantDelta?.({
          itemId: 'msg_1',
          phase: 'final_answer',
          text: 'hello from grok',
        });
        return {
          itemsToAppend: [
            {
              kind: 'assistant',
              phase: 'final_answer',
              text: 'hello from grok',
            },
          ],
          functionCalls: [],
          assistantText: 'hello from grok',
          finalText: 'hello from grok',
        };
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(observed.discoverySink, discoverySink);
  assert.deepEqual(
    {
      ...observed,
      discoverySink: undefined,
    },
    {
      accessToken: 'grok-token',
      authProviderId: 'grok_oauth',
      model: 'grok-4.5',
      history: [{ kind: 'user', text: 'hello' }],
      instructions: 'system\n\ncontext',
      reasoningEffort: 'high',
      discoverySink: undefined,
      providerWebSocketSessions: unusedProviderWebSocketSessions,
    },
  );
  assert.deepEqual(chunks, [
    {
      type: 'text_delta',
      text: 'hello from grok',
      phase: 'final_answer',
    },
    {
      type: 'done',
      assistantText: 'hello from grok',
      finalText: 'hello from grok',
    },
  ]);
});

void test('callModelWithDependencies uses Grok provider auth refresh for Grok OAuth auth failures', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const chunks = [];
  let attempts = 0;
  const authCalls: Array<{
    providerId: string | undefined;
    allowRefresh: boolean | undefined;
  }> = [];
  const refreshCalls: Array<{
    providerId: string | undefined;
    hasRefreshCredential: boolean;
  }> = [];

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: {
        ...defaultProviderRequestOptions,
        providerId: 'grok_oauth',
        model: 'grok',
      },
    },
    {
      getProviderAuth: async (options) => {
        authCalls.push({
          providerId: options.providerId,
          allowRefresh: options.allowRefresh,
        });
        return {
          accessToken: 'grok-token',
          accountId: 'grok-account',
        };
      },
      forceRefreshProviderAuth: async (options) => {
        refreshCalls.push({
          providerId: options.providerId,
          hasRefreshCredential: options.refreshCredential !== undefined,
        });
        return {
          accessToken: 'fresh-grok-token',
          accountId: 'grok-account',
        };
      },
      streamResponsesOverWebSocket: async () =>
        assert.fail('Codex websocket should not run'),
      streamGrokOAuthResponses: async (input) => {
        attempts += 1;
        assert.equal(input.accessToken, 'grok-token');
        if (attempts === 1) {
          throw Object.assign(new Error('expired token'), { status: 401 });
        }
        return {
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'ok',
          finalText: 'ok',
        };
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(attempts, 2);
  assert.deepEqual(authCalls, [
    {
      providerId: 'grok_oauth',
      allowRefresh: undefined,
    },
    {
      providerId: 'grok_oauth',
      allowRefresh: false,
    },
  ]);
  assert.deepEqual(refreshCalls, [
    {
      providerId: 'grok_oauth',
      hasRefreshCredential: false,
    },
  ]);
  assert.deepEqual(chunks, [
    {
      type: 'done',
      assistantText: 'ok',
      finalText: 'ok',
    },
  ]);
});

void test('callModelWithDependencies streams deltas and carries Codex output items on done', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  const itemsToAppend = [
    {
      kind: 'backend_item' as const,
      data: {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'opaque-reasoning',
      },
    },
    {
      kind: 'backend_item' as const,
      data: {
        id: 'msg_1',
        type: 'message',
        phase: 'commentary',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    },
    {
      kind: 'backend_item' as const,
      data: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    },
  ];

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: async ({ onAssistantDelta }) => {
        onAssistantDelta?.({
          itemId: 'item_1',
          phase: 'commentary',
          text: 'hello',
        });
        return {
          itemsToAppend,
          functionCalls: [
            {
              id: 'fc_1',
              callId: 'call_1',
              name: 'read_file',
              arguments: '{"path":"README.md"}',
            },
          ],
          assistantText: 'hello',
          finalText: '',
        };
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    {
      type: 'text_delta',
      text: 'hello',
      phase: 'commentary',
    },
    {
      type: 'tool_call',
      id: 'fc_1',
      callId: 'call_1',
      toolName: 'read_file',
      argumentsJson: '{"path":"README.md"}',
    },
    {
      type: 'done',
      assistantText: 'hello',
      finalText: '',
      itemsToAppend,
    },
  ]);
});

void test('callModelWithDependencies carries provider artifact candidates in done metadata', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: async () => ({
        itemsToAppend: [],
        functionCalls: [],
        assistantText:
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->\n# Chapter 1\n<!-- /GEULBAT_ARTIFACT -->',
        finalText:
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->\n# Chapter 1\n<!-- /GEULBAT_ARTIFACT -->',
        artifactCandidate: {
          renderer: 'markdown',
          payload: '\n# Chapter 1\n',
          digest: 'sha256:abc123',
        },
      }),
    },
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    {
      type: 'done',
      assistantText:
        '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->\n# Chapter 1\n<!-- /GEULBAT_ARTIFACT -->',
      finalText:
        '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->\n# Chapter 1\n<!-- /GEULBAT_ARTIFACT -->',
      artifactCandidate: {
        renderer: 'markdown',
        payload: '\n# Chapter 1\n',
        digest: 'sha256:abc123',
      },
    },
  ]);
});

void test('callModelWithDependencies carries provider structured outputs in done metadata', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  const structuredOutput = {
    schemaVersion: 1,
    kind: 'react_bundle_explicit_cdn_artifact',
    payload: {
      entryUrl: 'https://fixtures.geulbat.local/app.js',
      runtimeDependencies: {},
      dependencyRefs: [],
    },
  };

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: async () => ({
        itemsToAppend: [],
        functionCalls: [],
        assistantText: '',
        finalText: '',
        structuredOutputs: [structuredOutput],
      }),
    },
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    {
      type: 'done',
      assistantText: '',
      finalText: '',
      structuredOutputs: [structuredOutput],
    },
  ]);
});

void test('callModelWithDependencies aborts the background provider call when the consumer stops early', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();

  let providerSignal: AbortSignal | undefined;
  let providerAborted = false;

  const iterator = callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      streamResponsesOverWebSocket: async ({ signal, onAssistantDelta }) => {
        providerSignal = signal;
        onAssistantDelta?.({
          itemId: 'item_1',
          phase: 'commentary',
          text: 'hello',
        });

        await new Promise<void>((resolve) => {
          if (!signal) {
            resolve();
            return;
          }
          if (signal.aborted) {
            providerAborted = true;
            resolve();
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              providerAborted = true;
              resolve();
            },
            { once: true },
          );
        });

        return {
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'hello',
          finalText: '',
        };
      },
    },
  );

  const first = await iterator.next();
  assert.deepEqual(first, {
    done: false,
    value: {
      type: 'text_delta',
      text: 'hello',
      phase: 'commentary',
    },
  });

  await iterator.return(undefined);
  await delay(0);

  assert.ok(providerSignal);
  assert.equal(providerSignal.aborted, true);
  assert.equal(providerAborted, true);
});

void test('callModelWithDependencies logs provider failures with redacted conversation context', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const originalWarn = console.warn;
  const warns: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };

  try {
    const chunks = [];

    for await (const chunk of callModelWithDependencies(
      {
        history: [],
        systemPrompt: 'system',
        providerSessionId: 'provider-session',
        providerWebSocketSessions: unusedProviderWebSocketSessions,
        providerAuthRuntime: runtimeStore,
        providerRequestOptions: defaultProviderRequestOptions,
      },
      {
        getProviderAuth: async () => ({
          accessToken: 'token',
          accountId: 'account',
        }),
        forceRefreshProviderAuth: async () => ({
          accessToken: 'token',
          accountId: 'account',
        }),
        streamResponsesOverWebSocket: async () => {
          throw new Error('Provider request timed out');
        },
      },
    )) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [
      {
        type: 'error',
        code: 'llm_connect_timeout',
        message: 'provider request timed out',
      },
    ]);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warns.length, 1);
  assert.match(
    String(warns[0]?.[0] ?? ''),
    /warn \[llm\/provider\/client\] provider stream failed/,
  );
  const warnLine = String(warns[0]?.[0] ?? '');
  assert.match(warnLine, /conversationIdentityHash="[a-f0-9]{64}"/u);
  assert.doesNotMatch(warnLine, /provider-session/u);
  assert.equal(
    (warns[0]?.[1] as { code?: unknown })?.code,
    'llm_connect_timeout',
  );
  assert.equal(
    (warns[0]?.[1] as { cause?: unknown })?.cause,
    'Provider request timed out',
  );
});

void test('callModelWithDependencies logs redacted provider cache telemetry when usage is present', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    const chunks = [];

    for await (const chunk of callModelWithDependencies(
      {
        history: [{ kind: 'user', text: 'private prompt text' }],
        systemPrompt: 'private system prompt',
        promptContext: 'private prompt context',
        providerSessionId: 'provider-session',
        providerWebSocketSessions: unusedProviderWebSocketSessions,
        providerAuthRuntime: runtimeStore,
        providerRequestOptions: defaultProviderRequestOptions,
      },
      {
        getProviderAuth: async () => ({
          accessToken: 'token',
          accountId: 'account',
        }),
        forceRefreshProviderAuth: async () => ({
          accessToken: 'token',
          accountId: 'account',
        }),
        streamResponsesOverWebSocket: async () => ({
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'ok',
          finalText: 'ok',
          providerUsageTelemetry: {
            inputTokens: 100,
            outputTokens: 25,
            cachedInputTokens: 80,
          },
        }),
      },
    )) {
      chunks.push(chunk);
    }

    assert.deepEqual(chunks, [
      {
        type: 'done',
        assistantText: 'ok',
        finalText: 'ok',
        // Usage rides on the done chunk so the agent loop can aggregate
        // per-run totals (subagent drill-down telemetry).
        providerUsageTelemetry: {
          inputTokens: 100,
          outputTokens: 25,
          cachedInputTokens: 80,
        },
      },
    ]);
  } finally {
    console.log = originalLog;
  }

  const completedLog = logs.find((entry) =>
    String(entry[0] ?? '').includes('provider stream completed'),
  );
  assert.ok(completedLog);
  assert.equal(
    (completedLog[1] as { providerUsage?: unknown })?.providerUsage,
    'present',
  );
  assert.equal(
    (completedLog[1] as { inputTokens?: unknown })?.inputTokens,
    100,
  );
  assert.equal(
    (completedLog[1] as { outputTokens?: unknown })?.outputTokens,
    25,
  );
  assert.equal(
    (completedLog[1] as { cachedInputTokens?: unknown })?.cachedInputTokens,
    80,
  );
  assert.equal(
    (completedLog[1] as { cacheHitRatio?: unknown })?.cacheHitRatio,
    0.8,
  );
  const promptCacheKeyHash = (
    completedLog[1] as { promptCacheKeyHash?: unknown }
  )?.promptCacheKeyHash;
  assert.match(
    typeof promptCacheKeyHash === 'string' ? promptCacheKeyHash : '',
    /^[a-f0-9]{64}$/u,
  );
  assert.notEqual(promptCacheKeyHash, 'provider-session');
  const stablePrefixFingerprint = (
    completedLog[1] as { stablePrefixFingerprint?: unknown }
  )?.stablePrefixFingerprint;
  assert.match(
    typeof stablePrefixFingerprint === 'string' ? stablePrefixFingerprint : '',
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(
    (completedLog[1] as { prefixFingerprintVersion?: unknown })
      ?.prefixFingerprintVersion,
    'provider_visible_prefix_fingerprint_v1',
  );
  assert.equal(
    (completedLog[1] as { cacheProjectionVersion?: unknown })
      ?.cacheProjectionVersion,
    'provider_cache_projection_v2',
  );
  assert.doesNotMatch(JSON.stringify(completedLog), /"promptCacheKey":/u);
  assert.doesNotMatch(JSON.stringify(completedLog), /provider-session/u);
  assert.doesNotMatch(
    JSON.stringify(completedLog),
    /private prompt text|private system prompt|private prompt context|token/,
  );
});

void test('callModelWithDependencies forces one refresh and retries once after canonical auth failure', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  let token = 'stale-token';
  let streamCalls = 0;
  let forcedRefreshCalls = 0;

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: token,
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => {
        forcedRefreshCalls += 1;
        token = 'fresh-token';
        return {
          accessToken: token,
          accountId: 'account',
        };
      },
      streamResponsesOverWebSocket: async ({ headers }) => {
        streamCalls += 1;
        if (streamCalls === 1) {
          assert.equal(headers.get('Authorization'), 'Bearer stale-token');
          throw Object.assign(new Error('unauthorized'), {
            status: 401,
          });
        }

        assert.equal(headers.get('Authorization'), 'Bearer fresh-token');
        return {
          itemsToAppend: [],
          functionCalls: [],
          assistantText: 'assistant answer',
          finalText: 'assistant answer',
        };
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(forcedRefreshCalls, 1);
  assert.equal(streamCalls, 2);
  assert.deepEqual(chunks, [
    {
      type: 'done',
      assistantText: 'assistant answer',
      finalText: 'assistant answer',
    },
  ]);
});

void test('callModelWithDependencies does not retry auth failure after streamed text is committed', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  let token = 'stale-token';
  let streamCalls = 0;
  let forcedRefreshCalls = 0;

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: token,
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => {
        forcedRefreshCalls += 1;
        token = 'fresh-token';
        return {
          accessToken: token,
          accountId: 'account',
        };
      },
      streamResponsesOverWebSocket: async ({ headers, onAssistantDelta }) => {
        streamCalls += 1;
        assert.equal(headers.get('Authorization'), 'Bearer stale-token');
        onAssistantDelta?.({
          itemId: 'item_1',
          phase: 'final_answer',
          text: 'ATTEMPT-1-PARTIAL ',
        });
        throw Object.assign(new Error('unauthorized'), {
          status: 401,
        });
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(forcedRefreshCalls, 0);
  assert.equal(streamCalls, 1);
  assert.deepEqual(chunks, [
    {
      type: 'text_delta',
      text: 'ATTEMPT-1-PARTIAL ',
      phase: 'final_answer',
    },
    {
      type: 'error',
      code: 'llm_auth_failed',
      message: 'provider authentication failed',
    },
  ]);
});

void test('callModelWithDependencies does not loop after a second canonical auth failure', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  let streamCalls = 0;
  let forcedRefreshCalls = 0;

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: streamCalls === 0 ? 'stale-token' : 'fresh-token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => {
        forcedRefreshCalls += 1;
        return {
          accessToken: 'fresh-token',
          accountId: 'account',
        };
      },
      streamResponsesOverWebSocket: async () => {
        streamCalls += 1;
        throw Object.assign(new Error('unauthorized'), {
          status: 401,
        });
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(forcedRefreshCalls, 1);
  assert.equal(streamCalls, 2);
  assert.deepEqual(chunks, [
    {
      type: 'error',
      code: 'llm_auth_failed',
      message: 'provider authentication failed',
    },
  ]);
});

void test('callModelWithDependencies surfaces forced refresh invalidation as terminal auth failure', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  let streamCalls = 0;
  let forcedRefreshCalls = 0;

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'stale-token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => {
        forcedRefreshCalls += 1;
        throw Object.assign(
          new Error(
            'Saved provider credential is invalid. Reconnect the provider.',
          ),
          {
            llmCode: 'llm_auth_failed',
            code: 'provider_auth_invalid',
          },
        );
      },
      streamResponsesOverWebSocket: async () => {
        streamCalls += 1;
        throw Object.assign(new Error('unauthorized'), {
          status: 401,
        });
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(forcedRefreshCalls, 1);
  assert.equal(streamCalls, 1);
  assert.deepEqual(chunks, [
    {
      type: 'error',
      code: 'llm_auth_failed',
      message: 'provider authentication failed',
    },
  ]);
});

void test('callModelWithDependencies does not force refresh after a rate-limit failure', async () => {
  const chunks = [];
  const runtimeStore = createProviderAuthRuntimeStore();
  let streamCalls = 0;
  let forcedRefreshCalls = 0;

  for await (const chunk of callModelWithDependencies(
    {
      history: [],
      systemPrompt: 'system',
      providerSessionId: 'provider-session',
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: runtimeStore,
      providerRequestOptions: defaultProviderRequestOptions,
    },
    {
      getProviderAuth: async () => ({
        accessToken: 'token',
        accountId: 'account',
      }),
      forceRefreshProviderAuth: async () => {
        forcedRefreshCalls += 1;
        return {
          accessToken: 'fresh-token',
          accountId: 'account',
        };
      },
      streamResponsesOverWebSocket: async () => {
        streamCalls += 1;
        throw Object.assign(new Error('too many requests'), {
          status: 429,
        });
      },
    },
  )) {
    chunks.push(chunk);
  }

  assert.equal(forcedRefreshCalls, 0);
  assert.equal(streamCalls, 1);
  assert.deepEqual(chunks, [
    {
      type: 'error',
      code: 'llm_rate_limited',
      message: 'provider rate limited',
    },
  ]);
});

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
      responsesUrl: 'https://chatgpt.test/backend-api/codex/responses',
      fetchImpl: async (request, init) => {
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
      fetchImpl: async () =>
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
          accountId: '',
        };
      },
      forceRefreshProviderAuth: async (options) => {
        assert.equal(options.providerId, 'grok_oauth');
        forceRefreshCalls += 1;
        return { accessToken: 'fresh-token', accountId: '' };
      },
      fetchImpl: async (request, init) => {
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
});
