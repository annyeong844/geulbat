import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAuthRuntimeStore } from '../auth/runtime-state.js';
import type { ResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-session.js';
import type { AgentEvent, AgentEventEmitter } from './events.js';
import { createAgentEvent } from './events.js';
import { finalizeAfterToolLimit, runModelRound } from './loop-model-round.js';
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

function makeEmitter(events: AgentEvent[]): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
  };
}

void test('runModelRound aggregates deltas, function calls, and the composed system prompt', async () => {
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
    promptContext: 'prompt context',
    pendingBackgroundSystemNote: 'background note',
    round: 0,
    toolDefs: [],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
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
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['commentary_delta', 'final_answer_delta'],
  );
  assert.deepEqual(seenInput, {
    systemPrompt: 'system instructions\n\nprompt context\n\nbackground note',
    providerSessionId: threadId,
  });
});

void test('runModelRound streams final answer deltas as they arrive without a duplicate terminal emit', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(57),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
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
            item: { id: 'msg_1', type: 'message', phase: 'final_answer' },
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

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(52),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([
      {
        error: Object.assign(new Error('provider said no'), {
          llmCode: 'not_found',
        }),
      },
    ]),
  });

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
});

void test('runModelRound retries retryable stream errors before semantic output', async () => {
  const events: AgentEvent[] = [];
  let slept = false;
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(59),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    emit: makeEmitter(events),
    retrySleep: async () => {
      slept = true;
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
  assert.equal(slept, true);
  assert.deepEqual(events, [
    createAgentEvent('final_answer_delta', { text: 'done' }),
  ]);
});

void test('runModelRound does not retry after semantic output has been emitted', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  let attempts = 0;

  const result = await runModelRound({
    history: [],
    systemPrompt: 'system',
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(60),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
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
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 1,
    toolDefs: [],
    threadId: testThreadId(61),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
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
      promptContext: '',
      pendingBackgroundSystemNote: '',
      round: 1,
      toolDefs: [],
      threadId: testThreadId(62),
      providerWebSocketSessions: unusedProviderWebSocketSessions,
      providerAuthRuntime,
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
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(53),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
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

void test('finalizeAfterToolLimit returns fallback prose without emitting terminal events', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();

  const result = await finalizeAfterToolLimit({
    history: [],
    systemPrompt: 'system',
    threadId: testThreadId(54),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([{ events: [] }]),
  });

  assert.deepEqual(result, {
    ok: false,
    finalProse: 'max tool rounds reached',
  });
  assert.deepEqual(events, []);
});

void test('finalizeAfterToolLimit keeps raw artifact transport internal without emitting terminal events', async () => {
  const events: AgentEvent[] = [];
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const answer = [
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->',
    '# Chapter 1',
    '<!-- /GEULBAT_ARTIFACT -->',
  ].join('\n');

  const result = await finalizeAfterToolLimit({
    history: [],
    systemPrompt: 'system',
    threadId: testThreadId(55),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
    emit: makeEmitter(events),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound(answer),
    ]),
  });

  assert.deepEqual(result, {
    ok: false,
    finalProse: '',
    artifactCandidate: {
      renderer: 'markdown',
      payload: '\n# Chapter 1\n',
      digest: 'sha256:abc123',
    },
  });
  assert.deepEqual(events, []);
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
    promptContext: '',
    pendingBackgroundSystemNote: '',
    round: 0,
    toolDefs: [],
    threadId: testThreadId(56),
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime,
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
    },
  });
  assert.deepEqual(events, [
    createAgentEvent('final_answer_delta', {
      text: answer,
    }),
  ]);
});
