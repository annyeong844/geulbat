import test from 'node:test';
import assert from 'node:assert/strict';

import { createGlobMatcher } from './search-files-filename.js';

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
