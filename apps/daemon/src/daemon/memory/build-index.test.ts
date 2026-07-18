import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryIndexStore,
  resolveMemoryIndexScope,
  type MemoryIndexScope,
  type MemoryIndexStore,
} from './build-index.js';
import type { MemoryChunkRecord, MemoryManifest } from './types.js';
import type { SourceSnapshot } from './source-snapshot.js';

function createSourceSnapshot(label: string): SourceSnapshot {
  return {
    sourceIndexVersionToken: `source-index-${label}`,
    files: [
      {
        path: `docs/${label}.md`,
        sourceVersionToken: `source-file-${label}`,
        updatedAt: '2026-03-30T00:00:00.000Z',
        content: `# ${label}\nhello ${label}\n`,
        lines: [`# ${label}`, `hello ${label}`],
      },
    ],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createScope(
  sourceRoot: string,
  stateRoot = '/tmp/home-state',
): MemoryIndexScope {
  return { stateRoot, sourceRoot };
}

void test('createMemoryIndexStore shares one in-flight build per Home/source pair within a store', async () => {
  let buildCalls = 0;
  let writeCalls = 0;
  const gate = createDeferred<SourceSnapshot>();
  const store = createMemoryIndexStore({
    buildSourceSnapshot: async () => {
      buildCalls += 1;
      return gate.promise;
    },
    createGenerationId: () => 'generation-shared',
    writeIndexGeneration: async () => {
      writeCalls += 1;
    },
  });

  const scope = createScope('/tmp/source-a');
  const first = store.refreshMemoryIndex(scope);
  const second = store.refreshMemoryIndex(scope);

  await Promise.resolve();
  assert.equal(buildCalls, 1);

  gate.resolve(createSourceSnapshot('shared'));
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(writeCalls, 1);
  assert.equal(firstResult.generationId, 'generation-shared');
  assert.equal(secondResult.generationId, 'generation-shared');
});

void test('createMemoryIndexStore does not share in-flight builds across store instances', async () => {
  let buildCalls = 0;
  const gate = createDeferred<SourceSnapshot>();
  function createStore(label: string): MemoryIndexStore {
    return createMemoryIndexStore({
      buildSourceSnapshot: async () => {
        buildCalls += 1;
        return gate.promise;
      },
      createGenerationId: () => `generation-${label}`,
      writeIndexGeneration: async () => {},
    });
  }

  const first = createStore('first');
  const second = createStore('second');

  const scope = createScope('/tmp/source-b');
  const firstBuild = first.refreshMemoryIndex(scope);
  const secondBuild = second.refreshMemoryIndex(scope);

  await Promise.resolve();
  assert.equal(buildCalls, 2);

  gate.resolve(createSourceSnapshot('isolated'));
  const [firstResult, secondResult] = await Promise.all([
    firstBuild,
    secondBuild,
  ]);

  assert.equal(firstResult.generationId, 'generation-first');
  assert.equal(secondResult.generationId, 'generation-second');
});

void test('createMemoryIndexStore loads manifest and records through injected readTextFile', async () => {
  const manifest: MemoryManifest = {
    version: 2,
    generationId: 'generation-load',
    generatedAt: '2026-03-30T00:00:00.000Z',
    sourceDirectory: '/tmp/source-c',
    sourceIndexVersionToken: 'source-index-load',
    files: [
      {
        path: 'docs/load.md',
        sourceVersionToken: 'source-file-load',
        indexPath: 'memory/all-memory.jsonl',
        chunkCount: 1,
        updatedAt: '2026-03-30T00:00:00.000Z',
      },
    ],
  };
  const record: MemoryChunkRecord = {
    chunkId: 'docs/load.md#0001',
    path: 'docs/load.md',
    sourceVersionToken: 'source-file-load',
    title: 'Load',
    lineStart: 1,
    lineEnd: 2,
    excerpt: '# Load\nhello load',
    searchText: '# Load\nhello load',
  };
  const reads: string[] = [];
  const store = createMemoryIndexStore({
    readTextFile: async (path) => {
      reads.push(path);
      if (path.endsWith('manifest.json')) {
        return JSON.stringify(manifest);
      }
      return JSON.stringify(record) + '\n';
    },
  });

  const loaded = await store.loadMemoryIndex('/tmp/home-c');

  assert.equal(reads.length, 2);
  assert.equal(loaded.manifest.generationId, 'generation-load');
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0]?.chunkId, 'docs/load.md#0001');
});

void test('createMemoryIndexStore reuses loaded memory index metadata within a store', async () => {
  const manifest: MemoryManifest = {
    version: 2,
    generationId: 'generation-cached-load',
    generatedAt: '2026-03-30T00:00:00.000Z',
    sourceDirectory: '/tmp/source-cached',
    sourceIndexVersionToken: 'source-index-cached-load',
    files: [
      {
        path: 'docs/cached.md',
        sourceVersionToken: 'source-file-cached-load',
        indexPath: 'memory/all-memory.jsonl',
        chunkCount: 1,
        updatedAt: '2026-03-30T00:00:00.000Z',
      },
    ],
  };
  const record: MemoryChunkRecord = {
    chunkId: 'docs/cached.md#0001',
    path: 'docs/cached.md',
    sourceVersionToken: 'source-file-cached-load',
    title: 'Cached',
    lineStart: 1,
    lineEnd: 2,
    excerpt: '# Cached\nhello cached',
    searchText: '# Cached\nhello cached',
  };
  let readCalls = 0;
  const store = createMemoryIndexStore({
    readTextFile: async (path) => {
      readCalls += 1;
      return path.endsWith('manifest.json')
        ? JSON.stringify(manifest)
        : JSON.stringify(record) + '\n';
    },
  });

  const first = await store.loadMemoryIndex('/tmp/home-cached');
  const second = await store.loadMemoryIndex('/tmp/home-cached');

  assert.equal(readCalls, 2);
  assert.equal(first, second);
  assert.equal(second.manifest.generationId, 'generation-cached-load');
});

void test('createMemoryIndexStore invalidates loaded metadata after a successful refresh', async () => {
  let manifest: MemoryManifest = {
    version: 2,
    generationId: 'generation-before-refresh',
    generatedAt: '2026-03-30T00:00:00.000Z',
    sourceDirectory: '/tmp/source-refresh',
    sourceIndexVersionToken: 'source-index-before-refresh',
    files: [
      {
        path: 'docs/refresh.md',
        sourceVersionToken: 'source-file-before-refresh',
        indexPath: 'memory/all-memory.jsonl',
        chunkCount: 1,
        updatedAt: '2026-03-30T00:00:00.000Z',
      },
    ],
  };
  const record: MemoryChunkRecord = {
    chunkId: 'docs/refresh.md#0001',
    path: 'docs/refresh.md',
    sourceVersionToken: 'source-file-before-refresh',
    title: 'Refresh',
    lineStart: 1,
    lineEnd: 2,
    excerpt: '# Refresh\nhello refresh',
    searchText: '# Refresh\nhello refresh',
  };
  let readCalls = 0;
  const store = createMemoryIndexStore({
    buildSourceSnapshot: async () => createSourceSnapshot('after-refresh'),
    createGenerationId: () => 'generation-after-refresh',
    writeIndexGeneration: async () => {},
    readTextFile: async (path) => {
      readCalls += 1;
      return path.endsWith('manifest.json')
        ? JSON.stringify(manifest)
        : JSON.stringify(record) + '\n';
    },
  });

  const before = await store.loadMemoryIndex('/tmp/home-refresh');
  assert.equal(before.manifest.generationId, 'generation-before-refresh');
  assert.equal(readCalls, 2);

  await store.refreshMemoryIndex(
    createScope('/tmp/source-refresh', '/tmp/home-refresh'),
  );
  manifest = {
    ...manifest,
    generationId: 'generation-after-refresh',
    sourceIndexVersionToken: 'source-index-after-refresh',
  };

  const after = await store.loadMemoryIndex('/tmp/home-refresh');

  assert.equal(readCalls, 4);
  assert.equal(after.manifest.generationId, 'generation-after-refresh');
});

void test('createMemoryIndexStore scans the source root and writes only through Home state root', async () => {
  const scannedRoots: string[] = [];
  const writtenRoots: string[] = [];
  const manifests: MemoryManifest[] = [];
  const store = createMemoryIndexStore({
    buildSourceSnapshot: async (sourceRoot) => {
      scannedRoots.push(sourceRoot);
      return createSourceSnapshot('separate-roots');
    },
    createGenerationId: () => 'generation-separate-roots',
    writeIndexGeneration: async (stateRoot, manifest) => {
      writtenRoots.push(stateRoot);
      manifests.push(manifest);
    },
  });

  await store.refreshMemoryIndex({
    stateRoot: '/tmp/private-home-state',
    sourceRoot: '/tmp/computer-files/current-folder',
  });

  assert.deepEqual(scannedRoots, ['/tmp/computer-files/current-folder']);
  assert.deepEqual(writtenRoots, ['/tmp/private-home-state']);
  assert.equal(
    manifests[0]?.sourceDirectory,
    '/tmp/computer-files/current-folder',
  );
  assert.equal('sourceProjectId' in (manifests[0] ?? {}), false);
});

void test('resolveMemoryIndexScope resolves any host cwd and fails closed without a computer base', () => {
  assert.deepEqual(
    resolveMemoryIndexScope({
      stateRoot: '/tmp/private-home-state',
      computerFileRoot: '/computer',
      workingDirectory: 'Users/sample/Downloads',
    }),
    {
      stateRoot: '/tmp/private-home-state',
      sourceRoot: '/computer/Users/sample/Downloads',
    },
  );

  assert.throws(
    () =>
      resolveMemoryIndexScope({
        stateRoot: '/tmp/private-home-state',
        workingDirectory: 'Users/sample/Downloads',
      }),
    /Computer filesystem is unavailable/,
  );
  assert.deepEqual(
    resolveMemoryIndexScope({
      stateRoot: '/tmp/private-home-state',
      computerFileRoot: '/computer',
      workingDirectory: '../outside',
    }),
    {
      stateRoot: '/tmp/private-home-state',
      sourceRoot: '/outside',
    },
  );
  assert.deepEqual(
    resolveMemoryIndexScope({
      stateRoot: '/tmp/private-home-state',
      computerFileRoot: '/computer',
      workingDirectory: '/var/log',
    }),
    {
      stateRoot: '/tmp/private-home-state',
      sourceRoot: '/var/log',
    },
  );
});
