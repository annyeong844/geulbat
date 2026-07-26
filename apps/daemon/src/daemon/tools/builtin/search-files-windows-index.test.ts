import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWindowsFilenameIndexQuery,
  readWindowsFilenameIndexPattern,
  tryWindowsFilenameIndexSearch,
} from './search-files-windows-index.js';

void test('Windows index acceleration extracts exact basenames from path globs', () => {
  assert.deepEqual(readWindowsFilenameIndexPattern('package.json'), {
    operator: '=',
    literal: 'package.json',
  });
  assert.deepEqual(readWindowsFilenameIndexPattern('**/package.json'), {
    operator: '=',
    literal: 'package.json',
  });
  assert.deepEqual(readWindowsFilenameIndexPattern('docs/package.json'), {
    operator: '=',
    literal: 'package.json',
  });
});

void test('Windows index acceleration leaves wildcard filenames to filesystem search', () => {
  assert.equal(readWindowsFilenameIndexPattern('*.md'), undefined);
  assert.equal(readWindowsFilenameIndexPattern('note?.md'), undefined);
  assert.equal(readWindowsFilenameIndexPattern('entry[0].ts'), undefined);
  assert.equal(readWindowsFilenameIndexPattern(''), undefined);
});

void test('Windows index bounded mode accepts basename globs and escapes LIKE literals', () => {
  assert.deepEqual(
    readWindowsFilenameIndexPattern('*geulbat*', 'bounded_basename_glob'),
    { operator: 'LIKE', literal: '%geulbat%' },
  );
  assert.deepEqual(
    readWindowsFilenameIndexPattern('*100%_ready?*', 'bounded_basename_glob'),
    { operator: 'LIKE', literal: '%100[%][_]ready_%' },
  );
  assert.equal(
    readWindowsFilenameIndexPattern('docs/*geulbat*', 'bounded_basename_glob'),
    undefined,
  );
  assert.equal(
    readWindowsFilenameIndexPattern('!*.test.ts', 'bounded_basename_glob'),
    undefined,
  );
});

void test('Windows index bounded query uses caller-owned TOP, LIKE, and stable ordering', () => {
  assert.equal(
    buildWindowsFilenameIndexQuery({
      scope: 'file:C:/Users/user',
      pattern: '*geulbat*',
      queryMode: 'bounded_basename_glob',
      maxResults: 50,
    }),
    "SELECT TOP 50 System.ItemUrl FROM SystemIndex WHERE SCOPE='file:C:/Users/user' AND System.FileName LIKE '%geulbat%' ORDER BY System.ItemUrl",
  );
  assert.equal(
    buildWindowsFilenameIndexQuery({
      scope: 'file:C:/Users/user',
      pattern: "team's.json",
      queryMode: 'exact_hint',
    }),
    "SELECT System.ItemUrl FROM SystemIndex WHERE SCOPE='file:C:/Users/user' AND System.FileName='team''s.json' ORDER BY System.ItemUrl",
  );
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

void test('Windows index query fails closed without the daemon host command runtime', async () => {
  assert.deepEqual(
    await tryWindowsFilenameIndexSearch({
      rootDir: '/mnt/c/Users/user',
      pattern: 'package.json',
    }),
    {
      kind: 'unavailable',
      reasonCode: 'command_runtime_unavailable',
    },
  );
});
