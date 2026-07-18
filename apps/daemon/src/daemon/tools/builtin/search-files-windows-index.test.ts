import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readExactFilenamePattern,
  tryWindowsFilenameIndexSearch,
} from './search-files-windows-index.js';

void test('Windows index acceleration extracts exact basenames from path globs', () => {
  assert.equal(readExactFilenamePattern('package.json'), 'package.json');
  assert.equal(readExactFilenamePattern('**/package.json'), 'package.json');
  assert.equal(readExactFilenamePattern('docs/package.json'), 'package.json');
});

void test('Windows index acceleration leaves wildcard filenames to filesystem search', () => {
  assert.equal(readExactFilenamePattern('*.md'), undefined);
  assert.equal(readExactFilenamePattern('note?.md'), undefined);
  assert.equal(readExactFilenamePattern('entry[0].ts'), undefined);
  assert.equal(readExactFilenamePattern(''), undefined);
});

void test('Windows index acceleration reports unsupported roots without spawning PowerShell', async () => {
  assert.deepEqual(
    await tryWindowsFilenameIndexSearch({
      rootDir: '/tmp/geulbat-search',
      pattern: 'package.json',
    }),
    { kind: 'unavailable', reasonCode: 'unsupported_root' },
  );
});

void test('Windows index acceleration reports wildcard patterns without querying the index', async () => {
  assert.deepEqual(
    await tryWindowsFilenameIndexSearch({
      rootDir: '/mnt/c/Users/user',
      pattern: '*.json',
    }),
    { kind: 'unavailable', reasonCode: 'pattern_not_exact' },
  );
});
