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
  assert.deepEqual(events, []);
  assert.deepEqual(
    result.kind === 'success' ? result.artifactCandidate : undefined,
    artifactCandidate,
  );
});

void test('consumeModelRoundChunks reports retry-disabling semantic output for stream errors after text', async () => {
  const events: AgentEvent[] = [];

  const result = await consumeModelRoundChunks({
    chunks: chunks([
      { type: 'text_delta', text: 'partial' },
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
    createAgentEvent('commentary_delta', { text: 'partial' }),
  ]);
  assert.equal(result.kind, 'stream_error');
  assert.equal(
    result.kind === 'stream_error' ? result.sawSemanticChunk : undefined,
    true,
  );
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
