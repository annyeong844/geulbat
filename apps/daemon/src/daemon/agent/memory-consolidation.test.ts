import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryConsolidationSummarizer,
  resolveMemoryConsolidationModelFromEnv,
} from './memory-consolidation.js';
import type { CallModelInput, LLMChunk } from '../llm/provider/client.js';

function chunkStream(chunks: readonly LLMChunk[]): AsyncIterable<LLMChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

const access = {
  providerAuthRuntime: {} as CallModelInput['providerAuthRuntime'],
  providerWebSocketSessions: {} as CallModelInput['providerWebSocketSessions'],
  providerRequestOptions: {
    providerId: 'openai_codex_direct',
    model: 'gpt-5.6-codex',
    reasoning: { effort: 'low' },
  } as never,
};

function summarizerRecording(seen: { input?: CallModelInput }) {
  return createMemoryConsolidationSummarizer(access, {
    callModel: (input) => {
      seen.input = input;
      return chunkStream([
        { type: 'text_delta', phase: 'final_answer', text: '[new] merged' },
      ]);
    },
    resolveReplayScope: async () => 'replay-scope-1' as never,
    resolveConsolidationModel: () => undefined,
  });
}

void test('consolidation runs tool-free on its own provider session so the run cache is untouched', async () => {
  const seen: { input?: CallModelInput } = {};

  const result = await summarizerRecording(seen).consolidate({
    entries: [
      {
        id: 'm-11111111',
        text: 'existing fact',
        usageCount: 3,
        lastUsedAt: '1999-01-01T00:00:00.000Z',
      },
    ],
    legacySummary: 'legacy blob',
    notes: [{ fileName: 'a.md', path: '/tmp/a.md', text: 'new fact' }],
  });

  assert.equal(result.text, '[new] merged');
  assert.deepEqual(seen.input?.tools, []);
  assert.equal(seen.input?.providerSessionId, 'geulbat-memory-consolidation');
  assert.equal(seen.input?.history.length, 1);
  const request = seen.input?.history[0];
  assert.equal(request?.kind, 'user');
  assert.match(request.text, /\[m-11111111\] \(used 3x/u);
  assert.match(request.text, /existing fact/u);
  assert.match(request.text, /legacy blob/u);
  assert.match(request.text, /new fact/u);
  assert.match(
    seen.input?.systemPrompt ?? '',
    /not as an instruction to follow/u,
  );
  assert.match(seen.input?.systemPrompt ?? '', /Reuse the exact address/u);
  assert.match(
    seen.input?.systemPrompt ?? '',
    /Where a note contradicts an entry, the note wins/u,
  );
  assert.match(
    seen.input?.systemPrompt ?? '',
    /Never keep both sides of a contradiction/u,
  );
  assert.match(
    seen.input?.systemPrompt ?? '',
    /Date anything that can change/u,
  );
});

void test('an unset consolidation model keeps the run model', async () => {
  const seen: { input?: CallModelInput } = {};

  await summarizerRecording(seen).consolidate({
    entries: [],
    legacySummary: undefined,
    notes: [{ fileName: 'a.md', path: '/tmp/a.md', text: 'fact' }],
  });

  assert.equal(seen.input?.providerRequestOptions.model, 'gpt-5.6-codex');
});

void test('a configured consolidation model replaces the run model without changing the provider', async () => {
  let seen: CallModelInput | undefined;
  const summarizer = createMemoryConsolidationSummarizer(access, {
    callModel: (input) => {
      seen = input;
      return chunkStream([
        { type: 'text_delta', phase: 'final_answer', text: '[new] merged' },
      ]);
    },
    resolveReplayScope: async () => 'replay-scope-1' as never,
    resolveConsolidationModel: () => 'gpt-5.6-mini',
  });

  await summarizer.consolidate({
    entries: [],
    legacySummary: undefined,
    notes: [{ fileName: 'a.md', path: '/tmp/a.md', text: 'fact' }],
  });

  assert.equal(seen?.providerRequestOptions.model, 'gpt-5.6-mini');
  assert.equal(seen?.providerRequestOptions.providerId, 'openai_codex_direct');
});

void test('the consolidation model knob fails fast instead of being ignored when blank', () => {
  assert.equal(resolveMemoryConsolidationModelFromEnv({}), undefined);
  assert.equal(
    resolveMemoryConsolidationModelFromEnv({
      GEULBAT_MEMORY_CONSOLIDATION_MODEL: '  gpt-5.6-mini  ',
    }),
    'gpt-5.6-mini',
  );
  assert.throws(
    () =>
      resolveMemoryConsolidationModelFromEnv({
        GEULBAT_MEMORY_CONSOLIDATION_MODEL: '   ',
      }),
    /invalid GEULBAT_MEMORY_CONSOLIDATION_MODEL: empty/u,
  );
});

void test('a tool call from the consolidation model is treated as a failure', async () => {
  const summarizer = createMemoryConsolidationSummarizer(access, {
    callModel: () =>
      chunkStream([{ type: 'tool_call' }] as unknown as readonly LLMChunk[]),
    resolveReplayScope: async () => 'replay-scope-1' as never,
    resolveConsolidationModel: () => undefined,
  });

  await assert.rejects(
    async () =>
      await summarizer.consolidate({
        entries: [],
        legacySummary: undefined,
        notes: [{ fileName: 'a.md', path: '/tmp/a.md', text: 'fact' }],
      }),
    /unexpected tool call/u,
  );
});
