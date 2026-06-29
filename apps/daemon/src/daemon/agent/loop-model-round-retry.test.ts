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
    { delayMs: 125 },
  );

  assert.equal(
    decideModelRoundRetry({
      category: 'llm_rate_limited',
      attemptIndex: 0,
      sawSemanticChunk: true,
      policy: retryPolicy,
    }),
    null,
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
