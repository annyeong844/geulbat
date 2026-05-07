import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CONSUMER_FILES = [
  '../../../src/daemon/memory/source-snapshot.ts',
  '../../../src/daemon/memory/search-index.ts',
  '../../../src/daemon/memory/build-index.ts',
  '../../../src/daemon/memory/index-generation.ts',
  '../../../src/daemon/artifact-runtime-persistence/store.ts',
  '../../../src/daemon/tools/approval-runtime-policy.ts',
  '../../../src/daemon/tools/builtin/read-file.ts',
  '../../../src/daemon/tools/builtin/list-files.ts',
  '../../../src/daemon/tools/builtin/search-files.ts',
] as const;

void test('artifact-aware file-platform consumers do not import low-level normalize-path helpers directly', async () => {
  for (const relativePath of CONSUMER_FILES) {
    const fileUrl = new URL(relativePath, import.meta.url);
    const source = await readFile(fileUrl, 'utf8');
    assert.equal(
      source.includes('normalize-path.js'),
      false,
      `${relativePath} must use file-platform owner instead of normalize-path.js`,
    );
    assert.equal(
      source.includes('path-policy.js'),
      false,
      `${relativePath} must use file-platform owner instead of path-policy.js`,
    );
  }
});

void test('runtime-state and memory-index consumers do not restitch .geulbat roots from workspaceRoot', async () => {
  for (const relativePath of [
    '../../../src/daemon/artifact-runtime-persistence/store.ts',
    '../../../src/daemon/memory/build-index.ts',
    '../../../src/daemon/memory/index-generation.ts',
  ] as const) {
    const fileUrl = new URL(relativePath, import.meta.url);
    const source = await readFile(fileUrl, 'utf8');
    assert.equal(
      source.includes("join(workspaceRoot, '.geulbat'") ||
        source.includes('join(workspaceRoot, ".geulbat"'),
      false,
      `${relativePath} must resolve host-owned .geulbat paths through file-platform`,
    );
  }
});
