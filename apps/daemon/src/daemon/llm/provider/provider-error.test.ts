import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from './provider-error.js';

void test('normalizeProviderErrorCode maps aborted provider errors', () => {
  assert.equal(
    normalizeProviderErrorCode(new Error('Request was aborted')),
    'aborted',
  );
});

void test('sanitizeProviderErrorMessage removes raw provider details', () => {
  assert.equal(
    sanitizeProviderErrorMessage('internal'),
    'provider request failed',
  );
  assert.equal(
    sanitizeProviderErrorMessage('llm_context_preparation_required'),
    'context preparation required',
  );
  assert.equal(
    sanitizeProviderErrorMessage('provider_transition_required'),
    'provider transition requires a portable context handoff',
  );
});

void test('normalizeProviderErrorCode maps canonical provider auth app errors to llm_auth_failed', () => {
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(
        new Error(
          'Saved provider credential is invalid. Reconnect the provider.',
        ),
        {
          code: 'provider_auth_invalid',
        },
      ),
    ),
    'llm_auth_failed',
  );
});

void test('normalizeProviderErrorCode maps missing provider sessions to llm_auth_failed without parsing message text', () => {
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('No provider credentials available.'), {
        code: 'provider_auth_session_not_found',
      }),
    ),
    'llm_auth_failed',
  );
});

void test('normalizeProviderErrorCode does not infer auth failure from reconnect prose without an explicit code', () => {
  assert.equal(
    normalizeProviderErrorCode(
      new Error(
        'Saved provider credential is invalid. Reconnect the provider.',
      ),
    ),
    'internal',
  );
});

void test('normalizeProviderErrorCode only maps 400 context errors when length is explicit', () => {
  const contextLengthError = Object.assign(
    new Error('Context length exceeded for this request'),
    {
      status: 400,
    },
  );
  const genericContextError = Object.assign(
    new Error('Failed to parse request context'),
    {
      status: 400,
    },
  );

  assert.equal(
    normalizeProviderErrorCode(contextLengthError),
    'llm_context_length_exceeded',
  );
  assert.equal(normalizeProviderErrorCode(genericContextError), 'internal');
});

void test('normalizeProviderErrorCode preserves explicit llmCode before fallback parsing', () => {
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('Provider request timed out'), {
        llmCode: 'llm_idle_timeout',
      }),
    ),
    'llm_idle_timeout',
  );
});

void test('normalizeProviderErrorCode maps auth and rate-limit statuses directly', () => {
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('unauthorized'), {
        status: 401,
      }),
    ),
    'llm_auth_failed',
  );
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('too many requests'), {
        status: 429,
      }),
    ),
    'llm_rate_limited',
  );
});

void test('normalizeProviderErrorCode maps explicit timeout phrases without matching arbitrary timeout substrings', () => {
  assert.equal(
    normalizeProviderErrorCode(new Error('Provider request timed out')),
    'llm_connect_timeout',
  );
  assert.equal(
    normalizeProviderErrorCode(
      new Error('response parser timeout budget metadata missing'),
    ),
    'internal',
  );
});

void test('normalizeProviderErrorCode maps live provider capacity responses to overload', () => {
  const error = new Error(
    'The model is currently at capacity due to high demand. Please try again in a few minutes.',
  );

  assert.equal(normalizeProviderErrorCode(error), 'llm_overloaded');
  assert.equal(
    sanitizeProviderErrorMessage('llm_overloaded'),
    'provider overloaded',
  );
});

void test('normalizeProviderErrorCode still maps non-status context length messages', () => {
  assert.equal(
    normalizeProviderErrorCode(new Error('Model context length exceeded')),
    'llm_context_length_exceeded',
  );
});

void test('normalizeProviderErrorCode separates Qwen SSE max_tokens budget from input context overflow', () => {
  // qwen_token_plan only: HTTP SSE chat completions may send max_tokens
  // (e.g. summary compaction). Aliyun compatible-mode range rejection.
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('Range of max_tokens should be [1, 65536]'), {
        status: 400,
      }),
    ),
    'llm_output_budget_exceeded',
  );
  // Input overflow (shared wording) stays on the context path.
  assert.equal(
    normalizeProviderErrorCode(
      new Error('prompt is too long: reduce the length of the messages'),
    ),
    'llm_context_length_exceeded',
  );
  assert.equal(
    sanitizeProviderErrorMessage('llm_output_budget_exceeded'),
    'output token budget exceeded; lower max_tokens (this is not an input context overflow)',
  );
});

void test('normalizeProviderErrorCode separates usage exhaustion from transient rate limits', () => {
  // OpenAI-style quota exhaustion — do not burn rate-limit retries.
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('You exceeded your current quota'), {
        providerErrorCode: 'insufficient_quota',
      }),
    ),
    'llm_usage_limit_exceeded',
  );
  // Grok(xAI) spending limit arrives as 403 — not auth_failed.
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('spending limit reached'), {
        status: 403,
        providerErrorCode: 'personal-team-blocked:spending-limit',
      }),
    ),
    'llm_usage_limit_exceeded',
  );
  // Transient usage window still rate-limits (retryable).
  assert.equal(
    normalizeProviderErrorCode(
      new Error('Usage limit reached, try again in 5 minutes'),
    ),
    'llm_rate_limited',
  );
  // Plain rate limit stays rate-limited.
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(new Error('Rate limit exceeded'), { status: 429 }),
    ),
    'llm_rate_limited',
  );
  assert.equal(
    sanitizeProviderErrorMessage('llm_usage_limit_exceeded'),
    'provider usage or credit limit exceeded; top up or change plan (this is not a transient rate limit)',
  );
});

void test('normalizeProviderErrorCode classifies encrypted reasoning replay rejection before context overflow', () => {
  assert.equal(
    normalizeProviderErrorCode(
      Object.assign(
        new Error('The encrypted content for item rs_1 could not be verified.'),
        { status: 400, providerErrorCode: 'invalid_encrypted_content' },
      ),
    ),
    'llm_replay_state_rejected',
  );
  assert.equal(
    normalizeProviderErrorCode(
      new Error('could not decrypt the provided encrypted_content'),
    ),
    'llm_replay_state_rejected',
  );
  // Must not collapse into context length just because "content" appears.
  assert.notEqual(
    normalizeProviderErrorCode(
      new Error('The encrypted content for item rs_1 could not be verified.'),
    ),
    'llm_context_length_exceeded',
  );
});
