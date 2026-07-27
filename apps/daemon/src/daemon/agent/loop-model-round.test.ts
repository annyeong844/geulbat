import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from '../llm/provider/provider-options.js';
import { createProviderReplayScopeId } from '../llm/provider/provider-replay-scope.js';
import { resolveCodexResponsesUrl } from '../llm/provider/transport/responses-websocket-url.js';
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
const defaultProviderReplayScopeId = createProviderReplayScopeId({
  providerId: 'openai_codex_direct',
  accountId: 'account',
  endpoint: resolveCodexResponsesUrl(),
});

function makeEmitter(events: AgentEvent[]): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
  };
}

function withoutProviderStatus(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type !== 'provider_status');
}

void test('runModelRound emits factual auth, cooldown, and provider wait states', async () => {
  const events: AgentEvent[] = [];
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system instructions',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(50),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    now: () => 1_000,
    callModelImpl: async function* (input) {
      input.onProviderRuntimeState?.({ state: 'auth_waiting' });
      input.onProviderRuntimeState?.({ state: 'rate_limit_waiting' });
      input.onProviderRuntimeState?.({ state: 'provider_waiting' });
      yield {
        type: 'done',
        assistantText: 'done',
        finalText: 'done',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    events.filter((event) => event.type === 'provider_status'),
    [
      createAgentEvent('provider_status', {
        phase: 'provider_waiting',
        observedAt: '1970-01-01T00:00:01.000Z',
        request: {
          startedAt: '1970-01-01T00:00:01.000Z',
          attemptCount: 1,
        },
      }),
      createAgentEvent('provider_status', {
        phase: 'auth_waiting',
        observedAt: '1970-01-01T00:00:01.000Z',
        request: {
          startedAt: '1970-01-01T00:00:01.000Z',
          attemptCount: 1,
        },
      }),
      createAgentEvent('provider_status', {
        phase: 'rate_limit_waiting',
        observedAt: '1970-01-01T00:00:01.000Z',
        request: {
          startedAt: '1970-01-01T00:00:01.000Z',
          attemptCount: 1,
        },
      }),
      createAgentEvent('provider_status', {
        phase: 'provider_waiting',
        observedAt: '1970-01-01T00:00:01.000Z',
        request: {
          startedAt: '1970-01-01T00:00:01.000Z',
          attemptCount: 1,
        },
      }),
      createAgentEvent('provider_status', {
        phase: 'provider_streaming',
        observedAt: '1970-01-01T00:00:01.000Z',
        request: {
          startedAt: '1970-01-01T00:00:01.000Z',
          lastEventAt: '1970-01-01T00:00:01.000Z',
          attemptCount: 1,
        },
      }),
      createAgentEvent('provider_status', {
        phase: 'provider_streaming',
        observedAt: '1970-01-01T00:00:01.000Z',
        request: {
          startedAt: '1970-01-01T00:00:01.000Z',
          lastEventAt: '1970-01-01T00:00:01.000Z',
          endedAt: '1970-01-01T00:00:01.000Z',
          durationMs: 0,
          attemptCount: 1,
        },
      }),
    ],
  );
});

void test('runModelRound keeps instructions byte-stable while aggregating a round', async () => {
  const threadId = testThreadId(51);
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const onProviderRequestPrepared = () => undefined;
  let seenInput:
    | {
        systemPrompt: string;
        providerSessionId: string;
        onProviderRequestPrepared: unknown;
        deferredToolNames: string[] | undefined;
      }
    | undefined;

  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system instructions',
    round: 0,
    toolDefs: [],
    providerDeferredToolDefs: [
      {
        type: 'function',
        name: 'mcp_external_lookup',
        description: 'Look up an external record.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions: defaultProviderRequestOptions,
    onProviderRequestPrepared,
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
              onProviderRequestPrepared: input.onProviderRequestPrepared,
              deferredToolNames: input.deferredTools?.map((tool) => tool.name),
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
            id: 'rs-fc-1',
            type: 'reasoning',
            summary: [],
            encrypted_content: 'opaque-rs-fc-1',
          },
          providerReplayScopeId: defaultProviderReplayScopeId,
        },
        {
          kind: 'backend_item',
          data: {
            id: 'msg_1',
            type: 'message',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'thinking ' }],
          },
          providerReplayScopeId: defaultProviderReplayScopeId,
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
          providerReplayScopeId: defaultProviderReplayScopeId,
        },
        {
          kind: 'backend_item',
          data: {
            id: 'msg_2',
            type: 'message',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'done' }],
          },
          providerReplayScopeId: defaultProviderReplayScopeId,
        },
      ],
    },
  });
  assert.deepEqual(
    withoutProviderStatus(events).map((event) => event.type),
    ['commentary_delta', 'final_answer_delta'],
  );
  assert.deepEqual(seenInput, {
    systemPrompt: 'system instructions',
    providerSessionId: threadId,
    onProviderRequestPrepared,
    deferredToolNames: ['mcp_external_lookup'],
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
      // usable prose keeps the round alive; opaque items are still passed
      // through without interpretation (not treated as a visible answer by
      // themselves).
      yield {
        type: 'done',
        assistantText: 'kept',
        finalText: 'kept',
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

void test('runModelRound fails closed when the model returns no usable content', async () => {
  const events: AgentEvent[] = [];
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(60),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    async *callModelImpl() {
      yield {
        type: 'done',
        assistantText: '',
        finalText: '',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('error', {
      code: 'execution_failed',
      message: 'model returned no usable content',
    }),
  ]);
});

void test('runModelRound treats whitespace-only prose as no usable content', async () => {
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(61),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    async *callModelImpl() {
      yield {
        type: 'done',
        assistantText: '   \n\t  ',
        finalText: '  ',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.result.ok : true, false);
});

void test('runModelRound treats thinking-only opaque items without prose as no usable content', async () => {
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(62),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    async *callModelImpl() {
      yield {
        type: 'done',
        assistantText: '',
        finalText: '',
        itemsToAppend: [
          {
            kind: 'backend_item',
            data: {
              id: 'rs_think',
              type: 'reasoning',
              encrypted_content: 'opaque-only',
            },
          },
        ],
      };
    },
  });

  assert.equal(result.ok, false);
});

void test('runModelRound still accepts tool calls without visible prose', async () => {
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(63),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    async *callModelImpl() {
      yield {
        type: 'tool_call',
        id: 'fc-empty-prose',
        callId: 'call-empty-prose',
        toolName: 'read_file',
        argumentsJson: '{"path":"a.md"}',
      };
      yield {
        type: 'done',
        assistantText: '',
        finalText: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value.functionCalls : undefined, [
    {
      id: 'fc-empty-prose',
      callId: 'call-empty-prose',
      name: 'read_file',
      arguments: '{"path":"a.md"}',
    },
  ]);
});

void test('runModelRound fails closed when finish signals tool_calls but none arrived', async () => {
  const events: AgentEvent[] = [];
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(64),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    async *callModelImpl() {
      // Qwen HTTP SSE chat-completions mismatch: finish_reason=tool_calls
      // with empty tool payload. Narration must not become a final answer.
      // Codex/Grok Responses WS never set stopReason.
      yield {
        type: 'text_delta',
        text: 'Let me read the file first.',
        phase: 'final_answer',
      };
      yield {
        type: 'done',
        assistantText: 'Let me read the file first.',
        finalText: 'Let me read the file first.',
        stopReason: 'tool_calls',
      };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    result: { ok: false, finalProse: '' },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', {
      text: 'Let me read the file first.',
    }),
    createAgentEvent('error', {
      code: 'execution_failed',
      message: 'model signaled tool calls but returned none',
    }),
  ]);
});

void test('runModelRound accepts stopReason tool_calls when tool calls are present', async () => {
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'hello' }],
    systemPrompt: 'system',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(65),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter([]),
    async *callModelImpl() {
      yield {
        type: 'tool_call',
        id: 'fc-ok',
        callId: 'call-ok',
        toolName: 'read_file',
        argumentsJson: '{}',
      };
      yield {
        type: 'done',
        assistantText: '',
        finalText: '',
        stopReason: 'tool_calls',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.functionCalls.length : 0, 1);
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
          providerReplayScopeId: defaultProviderReplayScopeId,
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
          providerReplayScopeId: defaultProviderReplayScopeId,
        },
      ],
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
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
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', { text: 'done' }),
  ]);
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

void test('runModelRound logs a warning when chunks stall', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const nowValues = [0, 0, 0, 0, 10_001];

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
          providerReplayScopeId: defaultProviderReplayScopeId,
        },
      ],
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('final_answer_delta', {
      text: answer,
    }),
  ]);
});
