import test from 'node:test';
import assert from 'node:assert/strict';

import { parseResponseEvents } from './responses-parser.js';

void test('parseResponseEvents does not emit speculative deltas before phase is known and rejects missing phase at flush', async () => {
  const deltas: Array<{
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }> = [];

  await assert.rejects(
    parseResponseEvents(
      toAsyncEvents([
        {
          type: 'response.output_item.added',
          item: { id: 'msg_1', type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: '안녕',
        },
      ]),
      (delta) => deltas.push(delta),
    ),
    /missing assistant item phase/,
  );

  assert.deepEqual(deltas, []);
});

void test('parseResponseEvents flushes accumulated text once phase is known at item.done', async () => {
  const deltas: Array<{
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }> = [];

  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.output_item.added',
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta: '안녕',
      },
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', phase: 'final_answer' },
      },
    ]),
    (delta) => deltas.push(delta),
  );

  assert.deepEqual(deltas, [
    { itemId: 'msg_1', phase: 'final_answer', text: '안녕' },
  ]);
  assert.equal(result.assistantText, '안녕');
  assert.equal(result.finalText, '안녕');
});

void test('parseResponseEvents rejects missing phase at item.done instead of downgrading to commentary', async () => {
  const deltas: Array<{
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }> = [];

  await assert.rejects(
    parseResponseEvents(
      toAsyncEvents([
        {
          type: 'response.output_item.added',
          item: { id: 'msg_1', type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: '안녕',
        },
        {
          type: 'response.output_item.done',
          item: { id: 'msg_1', type: 'message' },
        },
      ]),
      (delta) => deltas.push(delta),
    ),
    /missing assistant item phase/,
  );

  assert.deepEqual(deltas, []);
});

void test('parseResponseEvents caps oversized provider error messages', async () => {
  const oversized = 'x'.repeat(700);

  await assert.rejects(
    parseResponseEvents(
      toAsyncEvents([
        {
          type: 'response.failed',
          response: {
            error: {
              message: oversized,
            },
          },
        },
      ]),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.endsWith('...(truncated)'));
      assert.ok(error.message.length <= 515);
      return true;
    },
  );
});

void test('parseResponseEvents preserves the original parse failure when iterator cleanup also fails', async () => {
  const parseError = new Error('next failed');
  const cleanupError = new Error('cleanup failed');

  const events: AsyncIterable<Record<string, unknown>> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          throw parseError;
        },
        async return(): Promise<IteratorResult<Record<string, unknown>>> {
          throw cleanupError;
        },
      };
    },
  };

  await assert.rejects(parseResponseEvents(events), /next failed/);
});

void test('parseResponseEvents rejects invalid assistant phase literals instead of downgrading to commentary', async () => {
  const deltas: Array<{
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }> = [];

  await assert.rejects(
    parseResponseEvents(
      toAsyncEvents([
        {
          type: 'response.output_item.added',
          item: { id: 'msg_1', type: 'message', phase: 'thinking' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: '안녕',
        },
      ]),
      (delta) => deltas.push(delta),
    ),
    /invalid assistant item phase "thinking"/,
  );

  assert.deepEqual(deltas, []);
});

void test('parseResponseEvents keeps explicit commentary before a tool call intact', async () => {
  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.output_item.added',
        item: { id: 'msg_1', type: 'message', phase: 'commentary' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta: '생각 중',
      },
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', phase: 'commentary' },
      },
      {
        type: 'response.output_item.done',
        item: {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{}',
        },
      },
    ]),
  );

  assert.equal(result.assistantText, '생각 중');
  assert.equal(result.finalText, '');
  assert.deepEqual(result.itemsToAppend, [
    { kind: 'assistant', phase: 'commentary', text: '생각 중' },
    {
      kind: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: 'read_file',
      arguments: '{}',
    },
  ]);
});

void test('parseResponseEvents surfaces a structured artifact candidate for legacy envelope final text', async () => {
  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.output_item.added',
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta:
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->\n# Chapter 1\n<!-- /GEULBAT_ARTIFACT -->',
      },
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', phase: 'final_answer' },
      },
    ]),
  );

  assert.equal(
    result.finalText,
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:abc123"} -->\n# Chapter 1\n<!-- /GEULBAT_ARTIFACT -->',
  );
  assert.deepEqual(result.artifactCandidate, {
    renderer: 'markdown',
    payload: '\n# Chapter 1\n',
    digest: 'sha256:abc123',
  });
});

void test('parseResponseEvents does not surface an artifact candidate from wrapped final-answer envelope text', async () => {
  const wrapped = [
    'Here is the preview.',
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:wrapped"} -->',
    '# Chapter 1',
    '<!-- /GEULBAT_ARTIFACT -->',
    'Use it if helpful.',
  ].join('\n');

  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.output_item.added',
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta: wrapped,
      },
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', phase: 'final_answer' },
      },
    ]),
  );

  assert.equal(result.finalText, wrapped);
  assert.equal(result.artifactCandidate, undefined);
});

void test('parseResponseEvents does not surface an artifact candidate from malformed final-answer envelope text', async () => {
  const malformed = [
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:broken"} -->',
    '# Chapter 1',
  ].join('\n');

  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.output_item.added',
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta: malformed,
      },
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', phase: 'final_answer' },
      },
    ]),
  );

  assert.equal(result.finalText, malformed);
  assert.equal(result.artifactCandidate, undefined);
});

void test('parseResponseEvents does not surface an artifact candidate from commentary-only envelope text', async () => {
  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.output_item.added',
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        delta:
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:commentary"} -->\n# scratch\n<!-- /GEULBAT_ARTIFACT -->',
      },
      {
        type: 'response.output_item.done',
        item: { id: 'msg_1', type: 'message', phase: 'commentary' },
      },
    ]),
  );

  assert.equal(
    result.assistantText,
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"sha256:commentary"} -->\n# scratch\n<!-- /GEULBAT_ARTIFACT -->',
  );
  assert.equal(result.finalText, '');
  assert.equal(result.artifactCandidate, undefined);
});

void test('parseResponseEvents normalizes provider usage cache telemetry from response completion metadata', async () => {
  const result = await parseResponseEvents(
    toAsyncEvents([
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            input_tokens_details: {
              cached_tokens: 90,
            },
          },
        },
      },
    ]),
  );

  assert.deepEqual(result.providerUsageTelemetry, {
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 90,
  });
});

async function* toAsyncEvents(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}
