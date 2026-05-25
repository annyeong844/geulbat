import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyStreamError } from './stream-error.js';

void test('classifyStreamError preserves explicit stream categories', () => {
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('budget exceeded'), {
        llmCode: 'abort_budget',
      }),
    ),
    'abort_budget',
  );
});

void test('classifyStreamError maps provider status and code shapes', () => {
  assert.equal(
    classifyStreamError({
      code: 'llm_rate_limited',
      message: 'provider rate limited',
    }),
    'llm_rate_limited',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('too many requests'), {
        status: 429,
      }),
    ),
    'llm_rate_limited',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('overloaded'), {
        status: 529,
      }),
    ),
    'llm_overloaded',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('unauthorized'), {
        status: 401,
      }),
    ),
    'llm_auth_expired',
  );
});

void test('classifyStreamError maps existing provider codes into stream categories', () => {
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('LLM idle timeout'), {
        llmCode: 'llm_idle_timeout',
      }),
    ),
    'llm_idle_timeout',
  );
  assert.equal(
    classifyStreamError(new Error('Provider request timed out')),
    'llm_connection_lost',
  );
  assert.equal(
    classifyStreamError(new Error('Model context length exceeded')),
    'llm_context_overflow',
  );
});

void test('classifyStreamError distinguishes user aborts and provider refusals', () => {
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('operation cancelled'), {
        name: 'AbortError',
      }),
    ),
    'abort_user',
  );
  assert.equal(
    classifyStreamError(new Error('response refused by content policy')),
    'llm_refused',
  );
});

void test('classifyStreamError maps connection loss indicators without treating unknowns as retryable', () => {
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('network reset'), {
        code: 'ECONNRESET',
      }),
    ),
    'llm_connection_lost',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    ),
    'llm_connection_lost',
  );
  assert.equal(classifyStreamError(new Error('unexpected failure')), 'unknown');
});
