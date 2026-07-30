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

void test('runModelRound publishes one active diagnostic before each concurrent durable request is prepared', async () => {
  const threadIds = [testThreadId(67), testThreadId(68), testThreadId(69)];
  let preparedCount = 0;
  let resolveAllPrepared: () => void = () => undefined;
  const allPrepared = new Promise<void>((resolve) => {
    resolveAllPrepared = resolve;
  });

  const lanes = threadIds.map((threadId, index) => {
    const events: AgentEvent[] = [];
    let releaseProvider: () => void = () => undefined;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const requestIdentity = `${index + 1}`.repeat(64);
    const result = runModelRound({
      history: [{ kind: 'user', text: `hello ${index}` }],
      systemPrompt: 'system instructions',
      round: 0,
      toolDefs: [],
      threadId,
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime: createProviderAuthRuntimeStore(),
      providerRequestOptions: defaultProviderRequestOptions,
      emit: makeEmitter(events),
      async onDurableProviderRequestPrepared(snapshot) {
        assert.equal(snapshot.requestIdentity, requestIdentity);
        assert.deepEqual(
          events.map((event) => event.type),
          ['provider_status'],
        );
        const activeStatus = events[0];
        assert.equal(activeStatus?.type, 'provider_status');
        if (activeStatus?.type !== 'provider_status') {
          assert.fail('provider request diagnostic was not published first');
        }
        assert.equal(activeStatus.payload.request?.endedAt, undefined);
        assert.equal(activeStatus.payload.request?.attemptCount, 1);
      },
      async *callModelImpl(input) {
        await input.onDurableProviderRequestPrepared?.({
          requestIdentity,
          providerRequestAttempt: 0,
          transportKind: 'websocket',
          resumed: false,
        });
        preparedCount += 1;
        if (preparedCount === threadIds.length) {
          resolveAllPrepared();
        }
        await providerReleased;
        yield {
          type: 'done',
          assistantText: `done ${index}`,
          finalText: `done ${index}`,
        };
      },
    });
    return { events, releaseProvider, result };
  });

  await allPrepared;
  assert.equal(
    lanes.filter((lane) => {
      const latest = lane.events.at(-1);
      return (
        latest?.type === 'provider_status' &&
        latest.payload.request?.endedAt === undefined
      );
    }).length,
    threadIds.length,
  );

  for (const lane of lanes) {
    lane.releaseProvider();
  }
  const results = await Promise.all(lanes.map((lane) => lane.result));
  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  assert.equal(
    lanes.filter((lane) => {
      const latest = lane.events.at(-1);
      return (
        latest?.type === 'provider_status' &&
        latest.payload.request?.endedAt !== undefined
      );
    }).length,
    threadIds.length,
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

void test('runModelRound does not promote tool-call commentary to terminal final prose', async () => {
  const events: AgentEvent[] = [];
  const recoveryCommentary =
    'I accidentally added an invalid key. Let me retry with a valid schema.';
  const result = await runModelRound({
    history: [{ kind: 'user', text: 'ask me the next planning question' }],
    systemPrompt: 'system',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(66),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: defaultProviderRequestOptions,
    emit: makeEmitter(events),
    async *callModelImpl() {
      yield {
        type: 'text_delta',
        text: recoveryCommentary,
        phase: 'commentary',
      };
      yield {
        type: 'tool_call',
        id: 'fc-ask-user-retry',
        callId: 'call-ask-user-retry',
        toolName: 'ask_user',
        argumentsJson:
          '{"questions":[{"header":"선택","id":"choice","question":"어느 쪽일까요?","options":[{"label":"첫 번째","description":"첫 번째 방향입니다."},{"label":"두 번째","description":"두 번째 방향입니다."}]}]}',
      };
      yield {
        type: 'done',
        assistantText: recoveryCommentary,
        finalText: '',
        stopReason: 'tool_calls',
      };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      assistantText: recoveryCommentary,
      terminalResult: { ok: true, finalProse: '' },
      functionCalls: [
        {
          id: 'fc-ask-user-retry',
          callId: 'call-ask-user-retry',
          name: 'ask_user',
          arguments:
            '{"questions":[{"header":"선택","id":"choice","question":"어느 쪽일까요?","options":[{"label":"첫 번째","description":"첫 번째 방향입니다."},{"label":"두 번째","description":"두 번째 방향입니다."}]}]}',
        },
      ],
    },
  });
  assert.deepEqual(withoutProviderStatus(events), [
    createAgentEvent('commentary_delta', { text: recoveryCommentary }),
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
