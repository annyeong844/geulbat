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

void test('normalizeProviderErrorCode still maps non-status context length messages', () => {
  assert.equal(
    normalizeProviderErrorCode(new Error('Model context length exceeded')),
    'llm_context_length_exceeded',
  );
});
