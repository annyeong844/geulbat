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
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('context preparation required'), {
        llmCode: 'llm_context_preparation_required',
      }),
    ),
    'llm_context_preparation_required',
  );
  assert.equal(
    classifyStreamError({
      code: 'provider_transition_required',
      message: 'provider transition requires a portable context handoff',
    }),
    'llm_provider_transition_required',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('provider request outcome is unknown'), {
        llmCode: 'llm_provider_request_outcome_unknown',
      }),
    ),
    'llm_provider_request_outcome_unknown',
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
        status: 503,
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
  assert.equal(
    classifyStreamError(new Error('Range of max_tokens should be [1, 65536]')),
    'llm_output_budget_exceeded',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(new Error('insufficient_quota'), {
        providerErrorCode: 'insufficient_quota',
      }),
    ),
    'llm_usage_limit_exceeded',
  );
  assert.equal(
    classifyStreamError(
      Object.assign(
        new Error('The encrypted content for item rs_1 could not be verified.'),
        { providerErrorCode: 'invalid_encrypted_content' },
      ),
    ),
    'llm_replay_state_rejected',
  );
  assert.equal(
    classifyStreamError(
      new Error('The model is currently at capacity due to high demand.'),
    ),
    'llm_overloaded',
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

// Qwen HTTP SSE 경로는 status만 넘기고 본문은 갖고 오지 않는다
// ("Qwen request failed with status 503"). status로 못 잡으면 unknown이 된다.
void test('classifyStreamError treats Qwen HTTP 503 as retryable overload', () => {
  const qwenServiceUnavailable = Object.assign(
    new Error('Qwen request failed with status 503'),
    { name: 'QwenHttpError', status: 503 },
  );

  assert.equal(classifyStreamError(qwenServiceUnavailable), 'llm_overloaded');
});
