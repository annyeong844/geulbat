import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildToolOutputCollectorRuntimeExpression,
  collectToolOutputPages,
} from './tool-output-recovery.js';

void test('collectToolOutputPages reconstructs every contiguous page exactly', async () => {
  const outputRef = 'tool-output:thread/run/call';
  const source = 'alpha-한글-omega';
  const requests: { offset: number; limit: number }[] = [];

  const result = await collectToolOutputPages({
    outputRef,
    pageLimit: 5,
    async readPage(request) {
      requests.push({ offset: request.offset, limit: request.limit });
      const content = source.slice(
        request.offset,
        request.offset + request.limit,
      );
      const endOffset = request.offset + content.length;
      const hasMore = endOffset < source.length;
      return {
        ok: true,
        outputRef,
        offset: request.offset,
        limit: request.limit,
        endOffset,
        totalChars: source.length,
        hasMore,
        nextOffset: hasMore ? endOffset : null,
        content,
      };
    },
  });

  assert.deepEqual(result, {
    outputRef,
    content: source,
    totalChars: source.length,
    pageCount: 3,
  });
  assert.deepEqual(requests, [
    { offset: 0, limit: 5 },
    { offset: 5, limit: 5 },
    { offset: 10, limit: 5 },
  ]);
});

void test('collectToolOutputPages rejects a non-advancing page', async () => {
  await assert.rejects(
    collectToolOutputPages({
      outputRef: 'tool-output:thread/run/call',
      pageLimit: 4,
      async readPage() {
        return {
          ok: true,
          outputRef: 'tool-output:thread/run/call',
          offset: 0,
          limit: 4,
          endOffset: 0,
          totalChars: 8,
          hasMore: true,
          nextOffset: 0,
          content: '',
        };
      },
    }),
    /non-terminal page did not advance/u,
  );
});

void test('collectToolOutputPages rejects snapshot identity drift', async () => {
  await assert.rejects(
    collectToolOutputPages({
      outputRef: 'tool-output:thread/run/call',
      pageLimit: 4,
      async readPage() {
        return {
          ok: true,
          outputRef: 'tool-output:another/run/call',
          offset: 0,
          limit: 4,
          endOffset: 4,
          totalChars: 4,
          hasMore: false,
          nextOffset: null,
          content: 'data',
        };
      },
    }),
    /page metadata does not match/u,
  );
});

void test('collectToolOutputPages requires an explicit positive page limit', async () => {
  await assert.rejects(
    collectToolOutputPages({
      outputRef: 'tool-output:thread/run/call',
      pageLimit: 0,
      async readPage() {
        assert.fail('invalid input must fail before reading a page');
      },
    }),
    /pageLimit must be a positive safe integer/u,
  );
});

void test('tool output collector runtime expression is self-contained', () => {
  const expression = buildToolOutputCollectorRuntimeExpression();

  assert.match(expression, /^\(async function collectToolOutputPages/u);
  assert.doesNotMatch(expression, /\b(?:import|require)\b/u);
});
