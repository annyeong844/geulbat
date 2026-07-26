import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_ARTIFACT_START_PREFIX } from './contract.js';
import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventEmitter,
} from './events.js';
import { consumeModelRoundChunks } from './loop-model-round-chunks.js';
import type { LLMChunk } from '../llm/index.js';

function makeEmitter(events: AgentEvent[]): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
  };
}

async function* chunks(items: readonly LLMChunk[]): AsyncGenerator<LLMChunk> {
  for (const item of items) {
    yield item;
  }
}

function createManualDeltaFlushScheduler(): {
  schedule(flush: () => void): () => void;
  fire(): void;
} {
  let scheduled: (() => void) | undefined;
  return {
    schedule(flush) {
      assert.equal(scheduled, undefined);
      scheduled = flush;
      return () => {
        if (scheduled === flush) {
          scheduled = undefined;
        }
      };
    },
    fire() {
      const flush = scheduled;
      if (flush === undefined) {
        throw new Error('no delta flush is scheduled');
      }
      scheduled = undefined;
      flush();
    },
  };
}

void test('consumeModelRoundChunks reports exact provider event observation times without changing chunk ownership', async () => {
  const events: AgentEvent[] = [];
  const observedAtMs: number[] = [];
  const nowValues = [0, 1_000, 1_250];

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      { type: 'text_delta', text: 'working' },
      { type: 'done', assistantText: 'working' },
    ]),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => nowValues.shift() ?? 1_250,
    onProviderEventObserved(value) {
      observedAtMs.push(value);
    },
  });

  assert.equal(result.kind, 'success');
  assert.deepEqual(observedAtMs, [1_000, 1_250]);
});

void test('consumeModelRoundChunks suppresses artifact-only prefix deltas when an artifact candidate is produced', async () => {
  const events: AgentEvent[] = [];
  const artifactCandidate = {
    renderer: 'markdown',
    payload: '\n# Title\n',
    digest: 'sha256:artifact',
  } as const;

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      {
        type: 'text_delta',
        phase: 'final_answer',
        text: AGENT_ARTIFACT_START_PREFIX.slice(0, 8),
      },
      {
        type: 'text_delta',
        phase: 'final_answer',
        text: AGENT_ARTIFACT_START_PREFIX.slice(8),
      },
      {
        type: 'done',
        assistantText: `${AGENT_ARTIFACT_START_PREFIX}{"renderer":"react_bundle"} -->`,
        finalText: '',
        artifactCandidate,
      },
    ]),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => 1_000,
  });

  assert.equal(result.kind, 'success');
  // 채팅(final_answer_delta)은 여전히 억제되지만, 확정된 봉투 텍스트는
  // artifact_stream_delta로 실시간 방출돼 중앙 창이 생성 과정을 그린다.
  assert.deepEqual(events, [
    {
      type: 'artifact_stream_delta',
      payload: { text: AGENT_ARTIFACT_START_PREFIX },
    },
  ]);
  assert.deepEqual(
    result.kind === 'success' ? result.artifactCandidate : undefined,
    artifactCandidate,
  );
});

void test('consumeModelRoundChunks reports retry-disabling semantic output for stream errors after text', async () => {
  const events: AgentEvent[] = [];

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      { type: 'text_delta', text: 'par' },
      { type: 'text_delta', text: 't' },
      { type: 'text_delta', text: 'ial' },
      {
        type: 'error',
        code: 'llm_rate_limited',
        message: 'rate limited after output',
      },
    ]),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => 1_000,
  });

  assert.deepEqual(events, [
    createAgentEvent('commentary_delta', { text: 'par' }),
    createAgentEvent('commentary_delta', { text: 'tial' }),
  ]);
  assert.equal(result.kind, 'stream_error');
  assert.equal(
    result.kind === 'stream_error' ? result.sawSemanticChunk : undefined,
    true,
  );
});

void test('consumeModelRoundChunks throttles a continuous delta lane while keeping its first chunk immediate', async () => {
  const events: AgentEvent[] = [];
  const scheduler = createManualDeltaFlushScheduler();
  async function* burst(): AsyncGenerator<LLMChunk> {
    yield { type: 'text_delta', text: 'a' };
    yield { type: 'text_delta', text: 'b' };
    yield { type: 'text_delta', text: 'c' };
    scheduler.fire();
    yield { type: 'text_delta', text: 'd' };
    yield { type: 'text_delta', text: 'e' };
    yield { type: 'done', assistantText: 'abcde' };
  }

  const result = await consumeModelRoundChunks({
    chunks: burst(),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => 1_000,
    scheduleDeltaFlush: scheduler.schedule,
  });

  assert.equal(result.kind, 'success');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'commentary_delta')
      .map((event) => event.payload.text),
    ['a', 'bc', 'de'],
  );
});

void test('consumeModelRoundChunks surfaces a scheduled delta delivery failure as a model-round error', async () => {
  const events: AgentEvent[] = [];
  const scheduler = createManualDeltaFlushScheduler();
  const deliveryFailure = new Error('event journal unavailable');
  async function* burst(): AsyncGenerator<LLMChunk> {
    yield { type: 'text_delta', text: 'a' };
    yield { type: 'text_delta', text: 'b' };
    scheduler.fire();
    yield { type: 'done', assistantText: 'ab' };
  }

  const result = await consumeModelRoundChunks({
    chunks: burst(),
    signal: undefined,
    emit(type, payload) {
      if (events.length > 0) {
        throw deliveryFailure;
      }
      events.push(createAgentEvent(type, payload));
    },
    attemptIndex: 0,
    now: () => 1_000,
    scheduleDeltaFlush: scheduler.schedule,
  });

  assert.equal(result.kind, 'thrown_error');
  if (result.kind !== 'thrown_error') {
    return;
  }
  assert.equal(result.error, deliveryFailure);
  assert.deepEqual(events, [
    createAgentEvent('commentary_delta', { text: 'a' }),
  ]);
});

void test('consumeModelRoundChunks flushes before delta type and tool-call identity boundaries', async () => {
  const events: AgentEvent[] = [];
  const scheduler = createManualDeltaFlushScheduler();

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      {
        type: 'tool_call_delta',
        itemId: 'fc_1',
        callId: 'call_1',
        toolName: 'visualize',
        argsDelta: 'x',
      },
      {
        type: 'tool_call_delta',
        itemId: 'fc_1',
        callId: 'call_1',
        toolName: 'visualize',
        argsDelta: 'y',
      },
      {
        type: 'tool_call_delta',
        itemId: 'fc_1',
        callId: 'call_1',
        toolName: 'visualize',
        argsDelta: 'z',
      },
      {
        type: 'tool_call_delta',
        itemId: 'fc_2',
        callId: 'call_2',
        toolName: 'visualize',
        argsDelta: 'm',
      },
      {
        type: 'tool_call_delta',
        itemId: 'fc_2',
        callId: 'call_2',
        toolName: 'visualize',
        argsDelta: 'n',
      },
      { type: 'text_delta', phase: 'final_answer', text: 'q' },
      { type: 'text_delta', phase: 'final_answer', text: 'r' },
      { type: 'done', finalText: 'qr' },
    ]),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => 1_000,
    round: 4,
    streamArgsToolNames: new Set(['visualize']),
    scheduleDeltaFlush: scheduler.schedule,
  });

  assert.equal(result.kind, 'success');
  assert.deepEqual(events, [
    createAgentEvent('commentary_delta', { text: 'a' }),
    createAgentEvent('commentary_delta', { text: 'b' }),
    createAgentEvent('tool_call_delta', {
      callId: 'call_1',
      step: 4,
      tool: 'visualize',
      argsDelta: 'x',
    }),
    createAgentEvent('tool_call_delta', {
      callId: 'call_1',
      step: 4,
      tool: 'visualize',
      argsDelta: 'yz',
    }),
    createAgentEvent('tool_call_delta', {
      callId: 'call_2',
      step: 4,
      tool: 'visualize',
      argsDelta: 'm',
    }),
    createAgentEvent('tool_call_delta', {
      callId: 'call_2',
      step: 4,
      tool: 'visualize',
      argsDelta: 'n',
    }),
    createAgentEvent('final_answer_delta', { text: 'q' }),
    createAgentEvent('final_answer_delta', { text: 'r' }),
  ]);
});

void test('consumeModelRoundChunks carries an opaque provider history batch only from done', async () => {
  const events: AgentEvent[] = [];
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

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      { type: 'text_delta', phase: 'commentary', text: 'checking' },
      {
        type: 'done',
        assistantText: 'checking',
        finalText: '',
        itemsToAppend,
      },
    ]),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => 1_000,
  });

  assert.equal(result.kind, 'success');
  assert.deepEqual(
    result.kind === 'success' ? result.itemsToAppend : undefined,
    itemsToAppend,
  );
});

void test('consumeModelRoundChunks emits tool_call_delta only for opted-in tools', async () => {
  const events: AgentEvent[] = [];

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      {
        type: 'tool_call_delta',
        itemId: 'fc_1',
        callId: 'call_viz',
        toolName: 'visualize',
        argsDelta: '{"code":"<svg',
      },
      {
        type: 'tool_call_delta',
        itemId: 'fc_2',
        callId: 'call_patch',
        toolName: 'apply_patch',
        argsDelta: '{"path":"a"',
      },
      {
        type: 'tool_call',
        id: 'fc_1',
        callId: 'call_viz',
        toolName: 'visualize',
        argumentsJson: '{"code":"<svg></svg>"}',
      },
      { type: 'done' },
    ]),
    signal: undefined,
    emit: makeEmitter(events),
    attemptIndex: 0,
    now: () => 0,
    round: 3,
    streamArgsToolNames: new Set(['visualize']),
  });

  assert.equal(result.kind, 'success');
  const deltaEvents = events.filter(
    (event) => event.type === 'tool_call_delta',
  );
  assert.deepEqual(
    deltaEvents.map((event) => event.payload),
    [
      {
        callId: 'call_viz',
        step: 3,
        tool: 'visualize',
        argsDelta: '{"code":"<svg',
      },
    ],
  );
  if (result.kind === 'success') {
    assert.equal(result.functionCalls.length, 1);
  }
});
