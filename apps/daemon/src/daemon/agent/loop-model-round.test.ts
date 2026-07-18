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
import { createModelRoundPort, runModelRound } from './loop-model-round.js';
import {
  composeProviderRounds,
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
  providerToolRound,
} from '../../test-support/provider-response-fixtures.js';
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

void test('runModelRound keeps instructions byte-stable while aggregating a round', async () => {
  const threadId = testThreadId(51);
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let seenInput:
    | {
        systemPrompt: string;
        providerSessionId: string;
      }
    | undefined;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system instructions',
    round: 0,
    toolDefs: [],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([
      composeProviderRounds(
        providerToolRound({
          toolName: 'read_file',
          argumentsJson: '{"path":"draft.md"}',
          commentaryText: 'thinking ',
        }),
        providerFinalAnswerRound('done', { itemId: 'msg_2' }),
        {
          inspectInput(input) {
            seenInput = {
              systemPrompt: input.systemPrompt,
              providerSessionId: input.providerSessionId,
            };
          },
        },
      ),
    ]),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'thinking done',
      terminalResult: {
        ok: true,
        finalProse: 'done',
      },
      functionCalls: [
        {
          id: 'fc-1',
          callId: 'call-1',
          name: 'read_file',
          arguments: '{"path":"draft.md"}',
        },
      ],
      itemsToAppend: [
        {
          kind: 'backend_item',
          data: {
            id: 'msg_1',
            type: 'message',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'thinking ' }],
          },
        },
        {
          kind: 'backend_item',
          data: {
            id: 'fc-1',
            type: 'function_call',
            call_id: 'call-1',
            name: 'read_file',
            arguments: '{"path":"draft.md"}',
          },
        },
        {
          kind: 'backend_item',
          data: {
            id: 'msg_2',
            type: 'message',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'done' }],
          },
        },
      ],
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['commentary_delta', 'final_answer_delta'],
  );
  assert.deepEqual(seenInput, {
    systemPrompt: 'system instructions',
    providerSessionId: threadId,
  });
});

void test('runModelRound carries provider history items without interpreting them', async () => {
  const itemsToAppend = [
    {
      kind: 'backend_item' as const,
      data: {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'opaque-reasoning',
      },
    },
  ];

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system instructions',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(59),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    async *callModelImpl() {
      yield {
        type: 'done',
        assistantText: '',
        finalText: '',
        itemsToAppend,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok ? result.value.itemsToAppend : undefined,
    itemsToAppend,
  );
});

void test('createModelRoundPort delegates to the current model-round runner', async () => {
  const threadId = testThreadId(58);
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const port = createModelRoundPort();

  const result = await port.runModelRound({
    history: [{ kind: 'user', text: 'hello through port' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('ported model round'),
    ]),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: 'ported model round',
      terminalResult: {
        ok: true,
        finalProse: 'ported model round',
      },
      functionCalls: [],
      itemsToAppend: [
        {
          kind: 'backend_item',
          data: {
            id: 'msg_1',
            type: 'message',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'ported model round' }],
          },
        },
      ],
    },
  });
});

void test('runModelRound streams final answer deltas as they arrive without a duplicate terminal emit', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(57),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([
      {
        events: [
          {
            type: 'response.output_item.added',
            item: { id: 'msg_1', type: 'message', phase: 'final_answer' },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            delta: '안녕',
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            delta: '하세요',
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'msg_1',
              type: 'message',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: '안녕하세요' }],
            },
          },
        ],
      },
    ]),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: '안녕하세요',
      terminalResult: {
        ok: true,
        finalProse: '안녕하세요',
      },
      functionCalls: [],
      itemsToAppend: [
        {
          kind: 'backend_item',
          data: {
            id: 'msg_1',
            type: 'message',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: '안녕하세요' }],
          },
        },
      ],
    },
  });
  assert.deepEqual(events, [
    createAgentEvent('final_answer_delta', { text: '안녕' }),
    createAgentEvent('final_answer_delta', { text: '하세요' }),
  ]);
});

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
  assert.deepEqual(events, [
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

void test('runModelRound retries retryable stream errors before semantic output', async () => {
  const events: AgentEvent[] = [];
  const sleptDelays: number[] = [];
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
    retrySleep: async (delayMs) => {
      sleptDelays.push(delayMs);
    },
    callModelImpl: async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: 'error',
          code: 'llm_rate_limited',
          message: 'provider rate limited',
        };
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
  assert.deepEqual(events, [
    createAgentEvent('final_answer_delta', { text: 'done' }),
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
  assert.deepEqual(events, [
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
    callModelImpl: async function* () {
      attempts += 1;
      yield { type: 'text_delta', text: 'partial' };
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
  assert.deepEqual(events, [
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
  assert.deepEqual(events, [
    createAgentEvent('final_answer_delta', { text: 'recovered' }),
  ]);
});

void test('runModelRound logs a warning when chunks stall', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const nowValues = [0, 0, 10_001];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await runModelRound({
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

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /model stream stalled between chunks/);
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
  assert.deepEqual(events, [
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
    events.map((event) => event.type),
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

void test('runModelRound treats wrapped legacy envelope final text as plain prose', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const answer = [
    'Here is the preview.',
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->',
    '# Chapter 1',
    '<!-- /GEULBAT_ARTIFACT -->',
    'Use it if helpful.',
  ].join('\n');

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(56),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound(answer),
    ]),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: answer,
      terminalResult: {
        ok: true,
        finalProse: answer,
      },
      functionCalls: [],
      itemsToAppend: [
        {
          kind: 'backend_item',
          data: {
            id: 'msg_1',
            type: 'message',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: answer }],
          },
        },
      ],
    },
  });
  assert.deepEqual(events, [
    createAgentEvent('final_answer_delta', {
      text: answer,
    }),
  ]);
});
