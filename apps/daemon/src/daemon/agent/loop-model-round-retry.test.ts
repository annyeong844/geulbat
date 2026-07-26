import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderRequestOptions } from '../llm/provider/provider-options.js';
import {
  decideModelRoundRetry,
  emitClassifiedStreamError,
} from './loop-model-round-retry.js';
import { createAgentEvent, type AgentEvent } from './events.js';

const retryPolicy = {
  ...resolveProviderRequestOptions({}).modelRoundRetry,
  delay: {
    baseDelayMs: 125,
    multiplier: 2,
    maxDelayMs: 1_000,
    jitterRatio: 0,
  },
};

void test('decideModelRoundRetry retries eligible categories before semantic output only', () => {
  assert.deepEqual(
    decideModelRoundRetry({
      category: 'llm_rate_limited',
      attemptIndex: 0,
      sawSemanticChunk: false,
      policy: retryPolicy,
    }),
    { kind: 'retry', delayMs: 125 },
  );

  assert.deepEqual(
    decideModelRoundRetry({
      category: 'llm_rate_limited',
      attemptIndex: 0,
      sawSemanticChunk: true,
      policy: retryPolicy,
    }),
    { kind: 'terminal', reason: 'unsafe_after_output' },
  );
});

void test('decideModelRoundRetry treats an explicitly configured idle timeout as a transient connection failure before output', () => {
  assert.deepEqual(
    decideModelRoundRetry({
      category: 'llm_idle_timeout',
      attemptIndex: 0,
      sawSemanticChunk: false,
      policy: retryPolicy,
    }),
    { kind: 'retry', delayMs: 125 },
  );
  assert.deepEqual(
    decideModelRoundRetry({
      category: 'llm_idle_timeout',
      attemptIndex: 0,
      sawSemanticChunk: true,
      policy: retryPolicy,
    }),
    { kind: 'terminal', reason: 'unsafe_after_output' },
  );
});

void test('decideModelRoundRetry distinguishes exhausted budget from an unavailable retry category', () => {
  assert.deepEqual(
    decideModelRoundRetry({
      category: 'llm_rate_limited',
      attemptIndex: retryPolicy.llmRateLimited.maxRetries,
      sawSemanticChunk: false,
      policy: retryPolicy,
    }),
    { kind: 'terminal', reason: 'exhausted' },
  );
  assert.deepEqual(
    decideModelRoundRetry({
      category: 'llm_auth_expired',
      attemptIndex: 0,
      sawSemanticChunk: false,
      policy: retryPolicy,
    }),
    { kind: 'terminal', reason: 'unavailable' },
  );
});

void test('emitClassifiedStreamError keeps provider categories on the terminal event surface', () => {
  const events: AgentEvent[] = [];
  const result = emitClassifiedStreamError(
    (type, payload) => {
      events.push(createAgentEvent(type, payload));
    },
    {
      category: 'llm_auth_expired',
      error: { code: 'llm_auth_failed' },
      message: 'provider authentication failed',
    },
  );

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.deepEqual(events, [
    createAgentEvent('error', {
      code: 'llm_auth_failed',
      message: 'provider authentication failed',
    }),
  ]);
});
