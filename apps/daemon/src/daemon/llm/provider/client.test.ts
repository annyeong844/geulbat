import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { callModelWithDependencies } from './client.js';
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
    model: 'gpt-5.5',
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
      streamResponsesOverWebSocket: async ({ body }) => {
        assert.equal(body.model, 'gpt-5.5');
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

void test('callModelWithDependencies streams deltas, then tool calls, then done', async () => {
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
      streamResponsesOverWebSocket: async ({ onAssistantDelta }) => {
        onAssistantDelta?.({
          itemId: 'item_1',
          phase: 'commentary',
          text: 'hello',
        });
        return {
          itemsToAppend: [],
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

void test('callModelWithDependencies logs provider failures with provider session context', async () => {
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
  assert.match(
    String(warns[0]?.[0] ?? ''),
    /providerSessionId="provider-session"/,
  );
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
  assert.equal(
    (completedLog[1] as { promptCacheKey?: unknown })?.promptCacheKey,
    'provider-session',
  );
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
