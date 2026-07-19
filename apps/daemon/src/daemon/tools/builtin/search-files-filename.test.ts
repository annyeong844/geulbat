import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGlobMatcher, filenameSearch } from './search-files-filename.js';

void test('filename glob **/ also matches files at the search root', () => {
  const matcher = createGlobMatcher('**/*.md');

  assert.equal(matcher?.('README.md'), true);
  assert.equal(matcher?.('docs/README.md'), true);
  assert.equal(matcher?.('README.txt'), false);
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
      searchFilenameIndex: async () => ({
        kind: 'results',
        paths: [indexedPath],
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
