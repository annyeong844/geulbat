import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testProjectId } from '../../../test-support/project-id.js';
import { createMemoryIndexStore } from '../../memory/build-index.js';
import { refreshMemoryIndexTool } from './refresh-memory-index.js';
import { searchMemoryIndexTool } from './search-memory-index.js';

function createSearchMemoryIndexContext(workspaceRoot: string) {
  return {
    callId: `call-search-${workspaceRoot}`,
    workspaceRoot,
    memoryIndex: createMemoryIndexStore(),
  };
}

function createRefreshMemoryIndexContext(workspaceRoot: string) {
  return {
    callId: `call-search-refresh-${workspaceRoot}`,
    workspaceRoot,
    projectId: testProjectId(),
    memoryIndex: createMemoryIndexStore(),
  };
}

void test('search_memory_index returns index_not_ready before refresh', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory' },
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'index_not_ready');
});

void test('search_memory_index rejects missing query at the parser boundary', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));

  const result = await searchMemoryIndexTool.execute(
    {},
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /query is required\./);
});

void test('search_memory_index rejects unexpected keys instead of ignoring them', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory', extra: true },
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('search_memory_index rejects non-positive or fractional maxResults at the parser boundary', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));

  for (const maxResults of [0, -1, 1.5]) {
    const result = await searchMemoryIndexTool.execute(
      { query: 'memory', maxResults },
      createSearchMemoryIndexContext(workspaceRoot),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'invalid_args');
    assert.match(result.error ?? '', /maxResults.*positive integer/);
  }
});

void test('search_memory_index rejects blank pathPrefix at the parser boundary', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));

  for (const pathPrefix of ['', '   ']) {
    const result = await searchMemoryIndexTool.execute(
      { query: 'memory', pathPrefix },
      createSearchMemoryIndexContext(workspaceRoot),
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'invalid_args');
    assert.match(result.error ?? '', /pathPrefix must not be empty\./);
  }
});

void test('search_memory_index matches against searchText and returns freshness metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });

  const filler = 'alpha '.repeat(40);
  await writeFile(
    join(workspaceRoot, 'docs', 'sample.md'),
    `# Sample\n${filler}\nvery-special-tail-token\n`,
    'utf8',
  );

  const refresh = await refreshMemoryIndexTool.execute(
    {},
    createRefreshMemoryIndexContext(workspaceRoot),
  );
  assert.equal(refresh.ok, true);

  const result = await searchMemoryIndexTool.execute(
    { query: 'very-special-tail-token', pathPrefix: 'docs', maxResults: 10 },
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    generationId: string;
    indexGeneratedAt: string;
    sourceIndexVersionToken: string;
    stale: boolean;
    total: number;
    truncated: boolean;
    results: Array<{ path: string; lineStart: number; excerpt: string }>;
  };

  assert.match(payload.generationId, /T/);
  assert.match(payload.indexGeneratedAt, /T/);
  assert.match(payload.sourceIndexVersionToken, /^[a-f0-9]{64}$/);
  assert.equal(payload.stale, false);
  assert.equal(payload.total, 1);
  assert.equal(payload.truncated, false);
  assert.equal(payload.results[0]?.path, 'docs/sample.md');
  assert.equal(payload.results[0]?.lineStart, 1);
});

void test('search_memory_index marks stale when workspace source snapshot changed', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'docs', 'sample.md'),
    '# Sample\nmemory index\n',
    'utf8',
  );

  const refresh = await refreshMemoryIndexTool.execute(
    {},
    createRefreshMemoryIndexContext(workspaceRoot),
  );
  assert.equal(refresh.ok, true);

  await writeFile(
    join(workspaceRoot, 'docs', 'sample.md'),
    '# Sample\nmemory index changed\n',
    'utf8',
  );

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory' },
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as { stale: boolean };
  assert.equal(payload.stale, true);
});

void test('search_memory_index rejects malformed manifest shapes instead of trusting parsed JSON', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));
  await mkdir(join(workspaceRoot, '.geulbat', 'index', 'memory'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, '.geulbat', 'index', 'manifest.json'),
    JSON.stringify({ version: 1, files: [] }) + '\n',
    'utf8',
  );
  await writeFile(
    join(workspaceRoot, '.geulbat', 'index', 'memory', 'all-memory.jsonl'),
    '',
    'utf8',
  );

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory' },
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
});

void test('search_memory_index rejects malformed chunk records instead of trusting parsed JSONL', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));
  await mkdir(join(workspaceRoot, '.geulbat', 'index', 'memory'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, '.geulbat', 'index', 'manifest.json'),
    JSON.stringify({
      version: 1,
      generationId: 'gen-1',
      generatedAt: new Date().toISOString(),
      sourceProjectId: 'workspace',
      sourceIndexVersionToken: 'abc',
      files: [],
    }) + '\n',
    'utf8',
  );
  await writeFile(
    join(workspaceRoot, '.geulbat', 'index', 'memory', 'all-memory.jsonl'),
    JSON.stringify({ chunkId: 'chunk-1', path: 'docs/a.md' }) + '\n',
    'utf8',
  );

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory' },
    createSearchMemoryIndexContext(workspaceRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
});

void test('search_memory_index can use an injected memory index store', async () => {
  const memoryIndex = createMemoryIndexStore({
    buildSourceSnapshot: async () => ({
      sourceIndexVersionToken: 'fresh-token',
      files: [],
    }),
    readTextFile: async (path) => {
      if (path.endsWith('manifest.json')) {
        return JSON.stringify({
          version: 1,
          generationId: 'local-memory-generation',
          generatedAt: '2026-03-30T00:00:00.000Z',
          sourceProjectId: 'workspace',
          sourceIndexVersionToken: 'fresh-token',
          files: [],
        });
      }
      return (
        JSON.stringify({
          chunkId: 'chunk-1',
          path: 'docs/sample.md',
          sourceVersionToken: 'source-1',
          title: 'Sample',
          lineStart: 1,
          lineEnd: 1,
          excerpt: 'memory token excerpt',
          searchText: 'memory token excerpt',
        }) + '\n'
      );
    },
  });

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory token' },
    {
      callId: 'call-search-local-store',
      workspaceRoot: '/tmp/memory-local-store',
      memoryIndex,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    generationId: string;
    stale: boolean;
    total: number;
  };
  assert.equal(payload.generationId, 'local-memory-generation');
  assert.equal(payload.stale, false);
  assert.equal(payload.total, 1);
});

void test('search_memory_index rejects missing memory index runtime', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-search-'));

  const result = await searchMemoryIndexTool.execute(
    { query: 'memory' },
    { callId: 'call-search-missing-runtime', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /memory index store is required/);
});
