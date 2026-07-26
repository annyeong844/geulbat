import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QWEN_TOKEN_PLAN_CHINA_BASE_URL,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  buildQwenPromptCacheProjection,
  getQwenTokenPlanConnectionStatus,
  loadQwenTokenPlanConfig,
  resolveQwenTokenPlanConfig,
} from './index.js';

void test('Qwen Token Plan defaults to the official global chat-completions endpoint', () => {
  const apiKey = 'x'.repeat(32);
  const config = resolveQwenTokenPlanConfig({
    model: ' qwen3.8-max-preview ',
    env: { BAILIAN_TOKEN_PLAN_API_KEY: ` ${apiKey} ` },
  });

  assert.equal(config.model, 'qwen3.8-max-preview');
  assert.equal(config.baseUrl, QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
  assert.equal(
    config.chatCompletionsUrl,
    `${QWEN_TOKEN_PLAN_GLOBAL_BASE_URL}/chat/completions`,
  );
  assert.match(config.credentialIdentity, /^[a-f0-9]{64}$/u);
  assert.equal(config.credentialIdentity.includes(apiKey), false);
});

void test('Qwen Token Plan accepts the official China base and trims one custom trailing slash', () => {
  const config = resolveQwenTokenPlanConfig({
    model: 'qwen3.8-max-preview',
    env: {
      BAILIAN_TOKEN_PLAN_API_KEY: 'x'.repeat(32),
      GEULBAT_QWEN_BASE_URL: `${QWEN_TOKEN_PLAN_CHINA_BASE_URL}/`,
    },
  });

  assert.equal(config.baseUrl, QWEN_TOKEN_PLAN_CHINA_BASE_URL);
  assert.equal(
    config.chatCompletionsUrl,
    `${QWEN_TOKEN_PLAN_CHINA_BASE_URL}/chat/completions`,
  );
});

void test('Qwen Token Plan fails closed for missing or blank credentials', () => {
  for (const env of [
    {},
    { BAILIAN_TOKEN_PLAN_API_KEY: '   ' },
  ] satisfies Record<string, string | undefined>[]) {
    assert.throws(
      () =>
        resolveQwenTokenPlanConfig({
          model: 'qwen3.8-max-preview',
          env,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'QwenConfigurationError' &&
        (error as Error & { llmCode?: unknown }).llmCode === 'llm_auth_failed',
    );
  }
});

void test('Qwen Token Plan rejects unsafe or non-HTTPS base URLs', () => {
  for (const baseUrl of [
    'http://example.com/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?route=other',
    'https://example.com/v1#fragment',
    '/compatible-mode/v1',
  ]) {
    assert.throws(() =>
      resolveQwenTokenPlanConfig({
        model: 'qwen3.8-max-preview',
        env: {
          BAILIAN_TOKEN_PLAN_API_KEY: 'x'.repeat(32),
          GEULBAT_QWEN_BASE_URL: baseUrl,
        },
      }),
    );
  }
});

void test('Qwen cache projection emits telemetry identity without provider wire controls', () => {
  const projection = buildQwenPromptCacheProjection({
    model: 'qwen3.8-max-preview',
    providerSessionId: 'provider-session',
    prefixMaterial: { instructions: 'system' },
  });

  assert.equal(projection.scope, 'disabled');
  assert.equal(projection.wire.prompt_cache_key, undefined);
  assert.equal(projection.trace.cacheKeyHash, undefined);
  assert.equal(projection.trace.providerId, 'qwen_token_plan');
  assert.equal(
    projection.trace.routeFamily,
    'qwen_token_plan_chat_completions',
  );
});

void test('Qwen async config loading gives the environment credential precedence', async () => {
  let storeRead = false;
  const config = await loadQwenTokenPlanConfig({
    model: 'qwen3.8-max-preview',
    env: { BAILIAN_TOKEN_PLAN_API_KEY: 'x'.repeat(32) },
    readCredentialImpl: async () => {
      storeRead = true;
      return { apiKey: 'y'.repeat(32), region: 'china' };
    },
  });

  assert.equal(storeRead, false);
  assert.equal(config.baseUrl, QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
});

void test('Qwen async config loading uses the stored region when no environment key exists', async () => {
  const config = await loadQwenTokenPlanConfig({
    model: 'qwen3.8-max-preview',
    env: {},
    readCredentialImpl: async () => ({
      apiKey: 'x'.repeat(32),
      region: 'china',
    }),
  });

  assert.equal(config.baseUrl, QWEN_TOKEN_PLAN_CHINA_BASE_URL);
});

void test('Qwen connection status reports missing without returning credential material', async () => {
  const status = await getQwenTokenPlanConnectionStatus({
    env: {},
    readCredentialImpl: async () => null,
  });

  assert.deepEqual(status, {
    state: 'missing',
    region: 'global',
    baseUrl: QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  });
});
