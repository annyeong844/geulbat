import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryIndexStore } from '../../memory/build-index.js';
import { refreshMemoryIndexTool } from './refresh-memory-index.js';

function createRefreshMemoryIndexContext(
  sourceRoot: string,
  memoryIndex = createMemoryIndexStore(),
  stateRoot = sourceRoot,
) {
  return {
    callId: `call-refresh-${sourceRoot}`,
    stateRoot,
    computerFileRoot: sourceRoot,
    workingDirectory: '',
    memoryIndex,
  };
}

void test('refresh_memory_index builds manifest and memory jsonl while skipping excluded files', async () => {
  assert.equal(refreshMemoryIndexTool.sideEffectLevel, 'write');
  assert.equal(refreshMemoryIndexTool.requiresApproval, true);

  const sourceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-refresh-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-home-state-'));
  await mkdir(join(sourceRoot, 'docs'), { recursive: true });
  await mkdir(join(sourceRoot, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'docs', 'sample.md'),
    '# Sample\r\nhello memory index\r\n',
    'utf8',
  );
  await writeFile(
    join(sourceRoot, 'package-lock.json'),
    '{"name":"skip"}\n',
    'utf8',
  );
  await writeFile(
    join(sourceRoot, 'node_modules', 'pkg', 'index.js'),
    'console.log("skip")\n',
    'utf8',
  );

  const result = await refreshMemoryIndexTool.execute(
    {},
    createRefreshMemoryIndexContext(
      sourceRoot,
      createMemoryIndexStore(),
      stateRoot,
    ),
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    manifestPath: string;
    memoryPath: string;
    fileCount: number;
    chunkCount: number;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.manifestPath, '.geulbat/index/manifest.json');
  assert.equal(payload.memoryPath, '.geulbat/index/memory/all-memory.jsonl');
  assert.equal(payload.fileCount, 1);
  assert.equal(payload.chunkCount, 1);

  const manifestRaw = await readFile(
    join(stateRoot, '.geulbat', 'index', 'manifest.json'),
    'utf8',
  );
  const memoryRaw = await readFile(
    join(stateRoot, '.geulbat', 'index', 'memory', 'all-memory.jsonl'),
    'utf8',
  );
  const manifest = JSON.parse(manifestRaw) as {
    version: number;
    sourceDirectory: string;
    generationId: string;
    files: Array<{ path: string; chunkCount: number }>;
  };
  const firstRecord = JSON.parse(memoryRaw.trim()) as {
    path: string;
    searchText: string;
  };

  assert.equal(manifest.version, 2);
  assert.equal(manifest.sourceDirectory, sourceRoot);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0]?.path, 'docs/sample.md');
  assert.equal(manifest.files[0]?.chunkCount, 1);
  assert.match(manifest.generationId, /T/);
  assert.equal(firstRecord.path, 'docs/sample.md');
  assert.match(firstRecord.searchText, /hello memory index/);
});

void test('refresh_memory_index rejects unexpected keys instead of silently ignoring them', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-refresh-'));

  const result = await refreshMemoryIndexTool.execute(
    { extra: true },
    createRefreshMemoryIndexContext(sourceRoot),
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('refresh_memory_index uses Home/source-scoped single-flight', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-refresh-'));
  await mkdir(join(sourceRoot, 'docs'), { recursive: true });
  await writeFile(
    join(sourceRoot, 'docs', 'sample.md'),
    '# Sample\nhello\n',
    'utf8',
  );
  const memoryIndex = createMemoryIndexStore();

  const [first, second] = await Promise.all([
    refreshMemoryIndexTool.execute(
      {},
      createRefreshMemoryIndexContext(sourceRoot, memoryIndex),
    ),
    refreshMemoryIndexTool.execute(
      {},
      createRefreshMemoryIndexContext(sourceRoot, memoryIndex),
    ),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const firstPayload = JSON.parse(first.output) as { generationId: string };
  const secondPayload = JSON.parse(second.output) as { generationId: string };
  assert.equal(firstPayload.generationId, secondPayload.generationId);
});

void test('refresh_memory_index can use an injected memory index store', async () => {
  const memoryIndex = createMemoryIndexStore({
    buildSourceSnapshot: async () => ({
      sourceIndexVersionToken: 'local-snapshot',
      files: [],
    }),
    createGenerationId: () => 'local-generation',
    writeIndexGeneration: async () => {},
  });

  const result = await refreshMemoryIndexTool.execute(
    {},
    {
      callId: 'call-refresh-local-store',
      stateRoot: '/tmp/memory-local-home',
      computerFileRoot: '/tmp',
      workingDirectory: 'memory-local-source',
      memoryIndex,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as { generationId: string };
  assert.equal(payload.generationId, 'local-generation');
});

void test('refresh_memory_index rejects missing memory index runtime', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'geulbat-memory-refresh-'));

  const result = await refreshMemoryIndexTool.execute(
    {},
    {
      callId: 'call-refresh-missing-runtime',
      stateRoot: sourceRoot,
      computerFileRoot: sourceRoot,
      workingDirectory: '',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /memory index store is required/);
});
