import test from 'node:test';
import assert from 'node:assert/strict';

import { searchMemoryIndex } from './search-index.js';
import type { MemoryChunkRecord, MemoryManifest } from './types.js';

const manifest: MemoryManifest = {
  version: 1,
  generationId: 'memory-generation',
  generatedAt: '2026-05-09T00:00:00.000Z',
  sourceProjectId: 'workspace',
  sourceIndexVersionToken: 'fresh-token',
  files: [],
};

function createRecord(args: {
  chunkId: string;
  title: string;
  searchText: string;
}): MemoryChunkRecord {
  return {
    chunkId: args.chunkId,
    path: `docs/${args.chunkId}.md`,
    sourceVersionToken: 'source-token',
    title: args.title,
    lineStart: 1,
    lineEnd: 1,
    excerpt: args.searchText,
    searchText: args.searchText,
  };
}

void test('searchMemoryIndex returns every match when maxResults is omitted', async () => {
  const records = Array.from({ length: 11 }, (_, index) =>
    createRecord({
      chunkId: `body-hit-${String(index).padStart(2, '0')}`,
      title: `Body Hit ${String(index).padStart(2, '0')}`,
      searchText: 'memory token',
    }),
  );

  const result = await searchMemoryIndex(
    '/tmp/workspace',
    { query: 'memory' },
    {
      memoryIndex: {
        computeCurrentSourceSnapshot: async () => ({
          sourceIndexVersionToken: 'fresh-token',
        }),
        loadMemoryIndex: async () => ({ manifest, records }),
      },
    },
  );

  assert.equal(result.total, 11);
  assert.equal(result.truncated, false);
  assert.equal(result.results.length, 11);
});

void test('searchMemoryIndex honors explicit maxResults without a hidden cap', async () => {
  const records = Array.from({ length: 52 }, (_, index) =>
    createRecord({
      chunkId: `body-hit-${String(index).padStart(2, '0')}`,
      title: `Body Hit ${String(index).padStart(2, '0')}`,
      searchText: 'memory token',
    }),
  );

  const result = await searchMemoryIndex(
    '/tmp/workspace',
    { query: 'memory', maxResults: 51 },
    {
      memoryIndex: {
        computeCurrentSourceSnapshot: async () => ({
          sourceIndexVersionToken: 'fresh-token',
        }),
        loadMemoryIndex: async () => ({ manifest, records }),
      },
    },
  );

  assert.equal(result.total, 52);
  assert.equal(result.truncated, true);
  assert.equal(result.results.length, 51);
});

void test('searchMemoryIndex rejects fractional maxResults instead of flooring it', async () => {
  await assert.rejects(
    searchMemoryIndex(
      '/tmp/workspace',
      { query: 'memory', maxResults: 1.5 },
      {
        memoryIndex: {
          computeCurrentSourceSnapshot: async () => ({
            sourceIndexVersionToken: 'fresh-token',
          }),
          loadMemoryIndex: async () => ({ manifest, records: [] }),
        },
      },
    ),
    /maxResults must be a positive integer\./,
  );
});

void test('searchMemoryIndex rejects blank pathPrefix instead of treating it as all paths', async () => {
  await assert.rejects(
    searchMemoryIndex(
      '/tmp/workspace',
      { query: 'memory', pathPrefix: '   ' },
      {
        memoryIndex: {
          computeCurrentSourceSnapshot: async () => ({
            sourceIndexVersionToken: 'fresh-token',
          }),
          loadMemoryIndex: async () => ({ manifest, records: [] }),
        },
      },
    ),
    /pathPrefix must not be empty\./,
  );
});

void test('searchMemoryIndex lowercases each searched field at most once per record', async () => {
  const records = [
    createRecord({
      chunkId: 'title-hit',
      title: 'Memory Alpha',
      searchText: 'body text',
    }),
    createRecord({
      chunkId: 'body-hit',
      title: 'Plain Title',
      searchText: 'Memory Beta',
    }),
  ];
  const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
  let lowercaseCalls = 0;
  String.prototype.toLocaleLowerCase = function patchedToLocaleLowerCase(
    this: string,
    ...args: Parameters<String['toLocaleLowerCase']>
  ): string {
    lowercaseCalls += 1;
    return originalToLocaleLowerCase.apply(this, args);
  };

  try {
    const result = await searchMemoryIndex(
      '/tmp/workspace',
      { query: 'memory', maxResults: 10 },
      {
        memoryIndex: {
          computeCurrentSourceSnapshot: async () => ({
            sourceIndexVersionToken: 'fresh-token',
          }),
          loadMemoryIndex: async () => ({ manifest, records }),
        },
      },
    );

    assert.equal(result.total, 2);
    assert.deepEqual(
      result.results.map((entry) => entry.chunkId),
      ['title-hit', 'body-hit'],
    );
    assert.equal(lowercaseCalls <= 1 + records.length * 2, true);
  } finally {
    String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
  }
});
