import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from '../llm/provider/provider-options.js';
import type { ResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-cache.js';
import type { AgentEvent, AgentEventEmitter } from './events.js';
import { createAgentEvent } from './events.js';
import { runModelRound } from './loop-model-round.js';
import { createScriptedProviderCallModel } from '../../test-support/provider-response-fixtures.js';
import { withoutProviderStatus } from '../../test-support/agent-events.js';
import { testThreadId } from '../../test-support/thread-id.js';

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

function makeEmitter(events: AgentEvent[]): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
  };
}

void test('runModelRound converts provider error chunks into terminal failure', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const originalError = console.error;
  const errors: unknown[][] = [];

  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  let result: Awaited<ReturnType<typeof runModelRound>>;
  try {
    result = await runModelRound({
      history: [],
      systemPrompt: 'system',
      round: 1,
      toolDefs: [],
      threadId: testThreadId(52),
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime,
      providerRequestOptions: defaultProviderRequestOptions,
      emit: makeEmitter(events),
      callModelImpl: createScriptedProviderCallModel([
        {
          error: Object.assign(new Error('provider said no'), {
            llmCode: 'not_found',
          }),
        },
      ]),
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'not_found',
      message: 'provider request failed',
    }),
  ]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.[0]), /model round failed/);
  assert.deepEqual(errors[0]?.[1], {
    category: 'unknown',
    code: 'not_found',
    cause: 'provider request failed',
  });
});

void test('runModelRound surfaces provider transition admission without retrying the target', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const originalError = console.error;
  let attempts = 0;

  console.error = () => {};
  let result: Awaited<ReturnType<typeof runModelRound>>;
  try {
    result = await runModelRound({
      history: [],
      systemPrompt: 'system',
      round: 1,
      toolDefs: [],
      threadId: testThreadId(53),
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime,
      providerRequestOptions: defaultProviderRequestOptions,
      emit: makeEmitter(events),
      callModelImpl: async function* () {
        attempts += 1;
        yield {
          type: 'error',
          code: 'provider_transition_required',
          message: 'provider transition requires a portable context handoff',
        };
      },
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'provider_transition_required',
      message: 'provider transition requires a portable context handoff',
    }),
  ]);
});

void test('runModelRound applies one consent-backed handoff to provider transition admission', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;
  let recoveryCalls = 0;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'continue on the selected provider' }],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(54),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextOverflow: async () => {
      recoveryCalls += 1;
      return true;
    },
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: 'error',
          code: 'provider_transition_required',
          message: 'provider transition requires a portable context handoff',
        };
        return;
      }
      yield { type: 'text_delta', text: 'recovered', phase: 'final_answer' };
      yield {
        type: 'done',
        assistantText: 'recovered',
        finalText: 'recovered',
      };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'recovered',
      terminalResult: { ok: true, finalProse: 'recovered' },
      functionCalls: [],
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', { text: 'recovered' }),
  ]);
});

void test('runModelRound retries retryable stream errors before semantic output', async () => {
  const events: AgentEvent[] = [];
  const sleptDelays: number[] = [];
  const providerRetryAfterMs = 2_500;
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(59),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      modelRoundRetry: {
        llmConnectionLost: { maxRetries: 2 },
        llmOverloaded: { maxRetries: 3 },
        llmRateLimited: { maxRetries: 3 },
        delay: {
          baseDelayMs: 123,
          multiplier: 2,
          maxDelayMs: 999,
          jitterRatio: 0,
        },
      },
    },
    emit: makeEmitter(events),
    now: () => 1_000,
    retrySleep: async (delayMs) => {
      sleptDelays.push(delayMs);
    },
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield Object.assign(
          {
            type: 'error' as const,
            code: 'llm_rate_limited',
            message: 'provider rate limited',
          },
          { retryAfterMs: providerRetryAfterMs },
        );
        return;
      }
      yield { type: 'text_delta', text: 'done', phase: 'final_answer' };
      yield { type: 'done', assistantText: 'done', finalText: 'done' };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'done',
      terminalResult: {
        ok: true,
        finalProse: 'done',
      },
      functionCalls: [],
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(sleptDelays, [123]);
  const providerStatuses = events.filter(
    (event): event is Extract<AgentEvent, { type: 'provider_status' }> =>
      event.type === 'provider_status',
  );
  assert.deepEqual(
    providerStatuses.find(
      (event) => event.payload.request?.retry?.outcome === 'scheduled',
    )?.payload.request?.retry,
    {
      available: true,
      performed: true,
      outcome: 'scheduled',
      retryAfterMs: providerRetryAfterMs,
    },
  );
  assert.deepEqual(providerStatuses.at(-1)?.payload.request, {
    startedAt: '1970-01-01T00:00:01.000Z',
    lastEventAt: '1970-01-01T00:00:01.000Z',
    endedAt: '1970-01-01T00:00:01.000Z',
    durationMs: 0,
    attemptCount: 2,
    retry: {
      available: false,
      performed: true,
      outcome: 'recovered',
      retryAfterMs: providerRetryAfterMs,
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', { text: 'done' }),
  ]);
});

void test('runModelRound shares its configured Retry-After-less overload backoff with provider admission', async () => {
  const events: AgentEvent[] = [];
  const sleptDelays: number[] = [];
  const sharedAdmissionDelays: Array<number | undefined> = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(75),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      modelRoundRetry: {
        llmConnectionLost: { maxRetries: 0 },
        llmOverloaded: { maxRetries: 1 },
        llmRateLimited: { maxRetries: 1 },
        delay: {
          baseDelayMs: 321,
          multiplier: 2,
          maxDelayMs: 999,
          jitterRatio: 0,
        },
      },
    },
    emit: makeEmitter(events),
    retrySleep: async (delayMs) => {
      sleptDelays.push(delayMs);
    },
    callModelImpl: async function* (input) {
      attempts += 1;
      if (attempts === 1) {
        const providerError = Object.assign(
          new Error('provider overloaded without Retry-After'),
          { status: 503 },
        );
        sharedAdmissionDelays.push(
          input.resolveProviderAdmissionFallbackDelayMs?.({
            error: providerError,
            sawSemanticChunk: false,
          }),
        );
        yield {
          type: 'error',
          code: 'llm_overloaded',
          message: 'provider overloaded',
        };
        return;
      }
      yield { type: 'text_delta', text: 'done', phase: 'final_answer' };
      yield { type: 'done', assistantText: 'done', finalText: 'done' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sharedAdmissionDelays, [321]);
  assert.deepEqual(sleptDelays, [321]);
});

void test('runModelRound performs one consent-backed context recovery before surfacing overflow', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;
  let recoveryCalls = 0;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'continue' }],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(64),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextOverflow: async () => {
      recoveryCalls += 1;
      return true;
    },
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: 'error',
          code: 'llm_context_length_exceeded',
          message: 'context length exceeded',
        };
        return;
      }
      yield { type: 'text_delta', text: 'recovered', phase: 'final_answer' };
      yield {
        type: 'done',
        assistantText: 'recovered',
        finalText: 'recovered',
      };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'recovered',
      terminalResult: { ok: true, finalProse: 'recovered' },
      functionCalls: [],
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', { text: 'recovered' }),
  ]);
});

void test('runModelRound does not retry when usage limit is exhausted', async () => {
  const events: AgentEvent[] = [];
  let attempts = 0;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(71),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    callModelImpl: async function* () {
      attempts += 1;
      yield {
        type: 'error',
        code: 'llm_usage_limit_exceeded',
        message:
          'provider usage or credit limit exceeded; top up or change plan (this is not a transient rate limit)',
      };
    },
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'llm_usage_limit_exceeded',
      message:
        'provider usage or credit limit exceeded; top up or change plan (this is not a transient rate limit)',
    }),
  ]);
});

void test('runModelRound strips encrypted reasoning once after replay rejection', async () => {
  const history = [
    { kind: 'user' as const, text: 'hello' },
    {
      kind: 'backend_item' as const,
      data: {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'opaque-blob',
      },
    },
  ];
  let attempts = 0;

  const result = await runModelRound({
    history,
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(72),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: 'error',
          code: 'llm_replay_state_rejected',
          message: 'provider rejected encrypted reasoning replay',
        };
        return;
      }
      yield { type: 'text_delta', text: 'recovered', phase: 'final_answer' };
      yield {
        type: 'done',
        assistantText: 'recovered',
        finalText: 'recovered',
      };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], { kind: 'user', text: 'hello' });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.assistantText : '', 'recovered');
});

void test('runModelRound terminals replay rejection when no encrypted items remain', async () => {
  let attempts = 0;
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(73),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    callModelImpl: async function* () {
      attempts += 1;
      yield {
        type: 'error',
        code: 'llm_replay_state_rejected',
        message: 'provider rejected encrypted reasoning replay',
      };
    },
  });

  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
});

void test('runModelRound does not run context recovery for output-budget rejections', async () => {
  const events: AgentEvent[] = [];
  let recoveryCalls = 0;
  let attempts = 0;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'continue' }],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(70),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextOverflow: async () => {
      recoveryCalls += 1;
      return true;
    },
    callModelImpl: async function* () {
      attempts += 1;
      // Provider rejected max_tokens — not an input overflow. Compaction must
      // not run; the same max_tokens would fail again deterministically.
      yield {
        type: 'error',
        code: 'llm_output_budget_exceeded',
        message:
          'output token budget exceeded; lower max_tokens (this is not an input context overflow)',
      };
    },
  });

  assert.equal(attempts, 1);
  assert.equal(recoveryCalls, 0);
  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'llm_output_budget_exceeded',
      message:
        'output token budget exceeded; lower max_tokens (this is not an input context overflow)',
    }),
  ]);
});

void test('runModelRound never loops context recovery after the compacted retry also overflows', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;
  let recoveryCalls = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(65),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextOverflow: async () => {
      recoveryCalls += 1;
      return true;
    },
    callModelImpl: async function* () {
      attempts += 1;
      yield {
        type: 'error',
        code: 'llm_context_length_exceeded',
        message: 'context length exceeded',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.equal(attempts, 2);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'llm_context_length_exceeded',
      message: 'context length exceeded',
    }),
  ]);
});

void test('runModelRound rebuilds a request once after typed pre-dispatch preparation', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;
  let preparationCalls = 0;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'continue' }],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(66),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextPreparationRequired: async () => {
      preparationCalls += 1;
      return { kind: 'prepared' };
    },
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: 'error',
          code: 'llm_context_preparation_required',
          message: 'context preparation required',
        };
        return;
      }
      yield { type: 'text_delta', text: 'prepared', phase: 'final_answer' };
      yield {
        type: 'done',
        assistantText: 'prepared',
        finalText: 'prepared',
      };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(preparationCalls, 1);
  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'prepared',
      terminalResult: { ok: true, finalProse: 'prepared' },
      functionCalls: [],
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', { text: 'prepared' }),
  ]);
});

void test('runModelRound surfaces a typed preparation failure without provider retry', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(67),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextPreparationRequired: async () => ({
      kind: 'failed',
      message: 'context preparation could not commit',
    }),
    callModelImpl: async function* () {
      attempts += 1;
      yield {
        type: 'error',
        code: 'llm_context_preparation_required',
        message: 'context preparation required',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'llm_context_length_exceeded',
      message: 'context preparation could not commit',
    }),
  ]);
});

void test('runModelRound never repeats pre-dispatch preparation after the rebuilt request is still too large', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;
  let preparationCalls = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(68),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    onContextPreparationRequired: async () => {
      preparationCalls += 1;
      return { kind: 'prepared' };
    },
    callModelImpl: async function* () {
      attempts += 1;
      yield {
        type: 'error',
        code: 'llm_context_preparation_required',
        message: 'context preparation required',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.equal(attempts, 2);
  assert.equal(preparationCalls, 1);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'llm_context_length_exceeded',
      message: 'context preparation required',
    }),
  ]);
});

void test('runModelRound respects startup-frozen retry policy when a retryable category is disabled', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(63),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: {
      ...defaultProviderRequestOptions,
      modelRoundRetry: {
        ...defaultProviderRequestOptions.modelRoundRetry,
        llmRateLimited: { maxRetries: 0 },
      },
    },
    emit: makeEmitter(events),
    retrySleep: async () => {
      assert.fail('retry sleep should not run when policy disables retry');
    },
    callModelImpl: async function* () {
      attempts += 1;
      yield {
        type: 'error',
        code: 'llm_rate_limited',
        message: 'provider rate limited',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'llm_rate_limited',
      message: 'provider rate limited',
    }),
  ]);
});

void test('runModelRound does not retry after semantic output has been emitted', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;
  let sharedAdmissionDelay: number | undefined;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(60),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    retrySleep: async () => undefined,
    callModelImpl: async function* (input) {
      attempts += 1;
      yield { type: 'text_delta', text: 'partial' };
      sharedAdmissionDelay = input.resolveProviderAdmissionFallbackDelayMs?.({
        error: Object.assign(new Error('provider rate limited'), {
          status: 429,
        }),
        sawSemanticChunk: true,
      });
      yield {
        type: 'error',
        code: 'llm_rate_limited',
        message: 'provider rate limited',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.equal(attempts, 1);
  assert.equal(sharedAdmissionDelay, undefined);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('commentary_delta', { text: 'partial' }),
    createAgentEvent('error', {
      code: 'llm_rate_limited',
      message: 'provider rate limited',
    }),
  ]);
});

void test('runModelRound classifies thrown stream failures before retrying', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(61),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    retrySleep: async () => undefined,
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        });
      }
      yield { type: 'text_delta', text: 'recovered', phase: 'final_answer' };
      yield {
        type: 'done',
        assistantText: 'recovered',
        finalText: 'recovered',
      };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'recovered',
      terminalResult: {
        ok: true,
        finalProse: 'recovered',
      },
      functionCalls: [],
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', { text: 'recovered' }),
  ]);
});

void test('runModelRound does not classify a five-minute inter-chunk gap as a stall', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const nowValues = [0, 0, 0, 0, 300_001];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: Awaited<ReturnType<typeof runModelRound>>;
  try {
    result = await runModelRound({
      history: [],
      systemPrompt: 'system',
      round: 1,
      toolDefs: [],
      threadId: testThreadId(62),
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime,
      providerRequestOptions: defaultProviderRequestOptions,
      emit: makeEmitter(events),
      now: () => nowValues.shift() ?? 10_001,
      callModelImpl: async function* () {
        yield { type: 'text_delta', text: 'a' };
        yield { type: 'text_delta', text: 'b' };
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.assistantText, 'ab');
  }
  assert.deepEqual(warnings, []);
});

void test('runModelRound returns aborted terminal failure when the model throws after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(53),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    signal: controller.signal,
    emit: makeEmitter(events),
    callModelImpl: async function* () {
      throw new Error('boom');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'aborted',
      message: 'run cancelled',
    }),
  ]);
});

void test('runModelRound returns aborted terminal failure when cancellation arrives between model chunks', async () => {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(54),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    signal: controller.signal,
    emit: makeEmitter(events),
    callModelImpl: async function* () {
      yield { type: 'text_delta', text: 'partial ' };
      controller.abort();
      yield { type: 'done', finalText: 'partial done' };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['commentary_delta', 'error'],
  );
  assert.deepEqual(events.at(-1), {
    type: 'error',
    payload: {
      code: 'aborted',
      message: 'run cancelled',
    },
  });
});
