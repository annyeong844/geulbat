import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderRequestOptions } from './provider-options.js';

const defaultModelRoundRetry = {
  llmConnectionLost: { maxRetries: 2 },
  llmOverloaded: { maxRetries: 3 },
  llmRateLimited: { maxRetries: 3 },
  delay: {
    baseDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 4_000,
    jitterRatio: 0.2,
  },
};

void test('resolveProviderRequestOptions returns daemon-local provider defaults', () => {
  assert.deepEqual(resolveProviderRequestOptions({}), {
    model: 'gpt-5.5',
    text: { verbosity: 'medium' },
    reasoning: { effort: 'medium', summary: 'auto' },
    modelRoundRetry: defaultModelRoundRetry,
  });
});

void test('resolveProviderRequestOptions trims configured provider options', () => {
  assert.deepEqual(
    resolveProviderRequestOptions({
      GEULBAT_CODEX_MODEL: ' gpt-5.4 ',
      GEULBAT_CODEX_REASONING_EFFORT: ' xhigh ',
      GEULBAT_CODEX_TEXT_VERBOSITY: ' high ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES: ' 4 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_OVERLOADED_MAX_RETRIES: ' 5 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES: ' 6 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS: ' 250 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER: ' 3 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS: ' 5000 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_JITTER_RATIO: ' 0.1 ',
    }),
    {
      model: 'gpt-5.4',
      text: { verbosity: 'high' },
      reasoning: { effort: 'xhigh', summary: 'auto' },
      modelRoundRetry: {
        llmConnectionLost: { maxRetries: 4 },
        llmOverloaded: { maxRetries: 5 },
        llmRateLimited: { maxRetries: 6 },
        delay: {
          baseDelayMs: 250,
          multiplier: 3,
          maxDelayMs: 5000,
          jitterRatio: 0.1,
        },
      },
    },
  );
});

for (const { name, env, error } of [
  {
    name: 'empty model',
    env: { GEULBAT_CODEX_MODEL: ' ' },
    error: /invalid GEULBAT_CODEX_MODEL: empty/,
  },
  {
    name: 'empty reasoning effort',
    env: { GEULBAT_CODEX_REASONING_EFFORT: ' ' },
    error: /invalid GEULBAT_CODEX_REASONING_EFFORT: empty/,
  },
  {
    name: 'empty text verbosity',
    env: { GEULBAT_CODEX_TEXT_VERBOSITY: ' ' },
    error: /invalid GEULBAT_CODEX_TEXT_VERBOSITY: empty/,
  },
  {
    name: 'empty retry base delay',
    env: { GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS: ' ' },
    error: /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS: empty/,
  },
  {
    name: 'unsupported reasoning effort',
    env: { GEULBAT_CODEX_REASONING_EFFORT: 'mid' },
    error: /invalid GEULBAT_CODEX_REASONING_EFFORT: mid/,
  },
  {
    name: 'unsupported text verbosity',
    env: { GEULBAT_CODEX_TEXT_VERBOSITY: 'verbose' },
    error: /invalid GEULBAT_CODEX_TEXT_VERBOSITY: verbose/,
  },
  {
    name: 'fractional retry count',
    env: {
      GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES: '1.5',
    },
    error:
      /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES: expected non-negative integer/,
  },
  {
    name: 'negative retry max delay',
    env: { GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS: '-1' },
    error:
      /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS: expected non-negative number/,
  },
  {
    name: 'zero retry multiplier',
    env: { GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER: '0' },
    error:
      /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER: expected positive number/,
  },
] as const) {
  void test(`resolveProviderRequestOptions rejects ${name}`, () => {
    assert.throws(() => resolveProviderRequestOptions(env), error);
  });
}
