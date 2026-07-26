import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCommandSessionHost } from '../../../command-host/session-core.js';
import { createGlobMatcher, filenameSearch } from './search-files-filename.js';

function createTestHostRouting(
  t: { after(fn: () => Promise<void> | void): void },
  stateRoot: string,
) {
  const pageLimitBytes = 4096;
  const hostCommands = createCommandSessionHost({
    inlineMaxBytes: pageLimitBytes,
    tailRingBytes: pageLimitBytes,
  });
  t.after(async () => {
    await hostCommands.closeAll();
  });
  return { hostCommands, stateRoot, pageLimitBytes };
}

void test('filename glob **/ also matches files at the search root', () => {
  const matcher = createGlobMatcher('**/*.md');

  assert.equal(matcher?.('README.md'), true);
  assert.equal(matcher?.('docs/README.md'), true);
  assert.equal(matcher?.('README.txt'), false);
});

void test('filename basename globs match at every directory depth', () => {
  const matcher = createGlobMatcher('*geulbat*');

  assert.equal(matcher?.('geulbat.json'), true);
  assert.equal(matcher?.('nested/geulbat-cache.json'), true);
  assert.equal(matcher?.('nested/unrelated.json'), false);
});

void test('filename glob matching keeps path separators semantic', () => {
  const matcher = createGlobMatcher('docs/*.md');

  assert.equal(matcher?.('docs/guide.md'), true);
  assert.equal(matcher?.('docs/nested/guide.md'), false);
});

void test('filename glob matching supports leading ! exclusions', () => {
  const matcher = createGlobMatcher('!**/*.test.ts');

  assert.equal(matcher?.('src/product.ts'), true);
  assert.equal(matcher?.('src/product.test.ts'), false);
});

void test('filename search includes unindexed filesystem matches after partial Windows index results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-filename-index-hint-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const indexedDirectory = join(root, 'indexed');
  const freshDirectory = join(root, 'fresh');
  await Promise.all([mkdir(indexedDirectory), mkdir(freshDirectory)]);
  const indexedPath = join(indexedDirectory, 'target.txt');
  await Promise.all([
    writeFile(indexedPath, 'indexed\n', 'utf8'),
    writeFile(join(freshDirectory, 'target.txt'), 'fresh\n', 'utf8'),
  ]);

  const result = await filenameSearch(
    root,
    root,
    '**/target.txt',
    createGlobMatcher('**/target.txt'),
    null,
    undefined,
    undefined,
    {
      hostRouting: createTestHostRouting(t, root),
      searchFilenameIndex: async () => ({
        kind: 'results',
        paths: [indexedPath],
        limited: false,
      }),
    },
  );

  assert.equal(result.backend, 'windows-search-index+ripgrep-files');
  assert.equal(result.consistency, 'eventual_index');
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.results.map((match) => match.path),
    ['fresh/target.txt', 'indexed/target.txt'],
  );
});

void test('filename search returns explicit bounded eventual-index results without a filesystem scan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-filename-index-fast-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const nestedDirectory = join(root, 'nested');
  await mkdir(nestedDirectory);
  const indexedPath = join(nestedDirectory, 'geulbat-cache.json');
  await writeFile(indexedPath, 'indexed\n', 'utf8');

  const result = await filenameSearch(
    root,
    root,
    '*geulbat*',
    createGlobMatcher('*geulbat*'),
    null,
    1,
    undefined,
    {
      consistency: 'eventual_index',
      searchFilenameIndex: async (args) => {
        assert.deepEqual(args, {
          rootDir: root,
          pattern: '*geulbat*',
          queryMode: 'bounded_basename_glob',
          maxResults: 1,
        });
        return { kind: 'results', paths: [indexedPath], limited: true };
      },
    },
  );

  assert.equal(result.backend, 'windows-search-index');
  assert.equal(result.consistency, 'eventual_index');
  assert.equal(result.total, 1);
  assert.equal(result.totalRelation, 'lower_bound');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results, [
    { path: 'nested/geulbat-cache.json', line: 0, text: '' },
  ]);
});

void test('filename search does not silently fall back when an explicit index query is unavailable', async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), 'geulbat-filename-index-unavailable-'),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    filenameSearch(
      root,
      root,
      '*geulbat*',
      createGlobMatcher('*geulbat*'),
      null,
      50,
      undefined,
      {
        consistency: 'eventual_index',
        searchFilenameIndex: async () => ({
          kind: 'unavailable',
          reasonCode: 'query_failed',
        }),
      },
    ),
    (error: unknown) => {
      assert.equal(Reflect.get(error as object, 'code'), 'execution_failed');
      assert.match(String(error), /Windows filename index.*query_failed/u);
      return true;
    },
  );
});
