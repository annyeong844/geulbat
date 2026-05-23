import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProviderCacheTelemetryLogFields,
  normalizeProviderUsageTelemetry,
} from './provider-cache-telemetry.js';
import type { ProviderUsageTelemetry } from './wire/types.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _ProviderUsageTelemetryRejectsEmptyShape = Expect<
  Equal<
    Record<never, never> extends ProviderUsageTelemetry ? true : false,
    false
  >
>;

void test('normalizeProviderUsageTelemetry reads snake-case OpenAI usage fields', () => {
  assert.deepEqual(
    normalizeProviderUsageTelemetry({
      input_tokens: 120,
      output_tokens: 30,
      input_tokens_details: {
        cached_tokens: 90,
      },
    }),
    {
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 90,
    },
  );
});

void test('normalizeProviderUsageTelemetry reads camel-case usage fields', () => {
  assert.deepEqual(
    normalizeProviderUsageTelemetry({
      inputTokens: 80,
      outputTokens: 20,
      inputTokensDetails: {
        cachedTokens: 40,
      },
    }),
    {
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 40,
    },
  );
});

void test('normalizeProviderUsageTelemetry ignores absent or invalid usage instead of fabricating telemetry', () => {
  assert.equal(normalizeProviderUsageTelemetry(undefined), undefined);
  assert.equal(
    normalizeProviderUsageTelemetry({
      input_tokens: -1,
      output_tokens: 1.5,
      input_tokens_details: {
        cached_tokens: '90',
      },
    }),
    undefined,
  );
});

void test('buildProviderCacheTelemetryLogFields reports absent usage without cache identifiers', () => {
  assert.deepEqual(
    buildProviderCacheTelemetryLogFields(undefined, {
      providerSessionId: 'provider-session',
      promptCacheKey: 'prompt-cache-key',
    }),
    { providerUsage: 'absent' },
  );
});

void test('buildProviderCacheTelemetryLogFields reports cache hit ratio when usage is present', () => {
  assert.deepEqual(
    buildProviderCacheTelemetryLogFields(
      {
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 80,
      },
      {
        providerSessionId: 'provider-session',
        promptCacheKey: 'prompt-cache-key',
      },
    ),
    {
      providerUsage: 'present',
      providerSessionId: 'provider-session',
      promptCacheKey: 'prompt-cache-key',
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 80,
      cacheHitRatio: 0.8,
    },
  );
});
