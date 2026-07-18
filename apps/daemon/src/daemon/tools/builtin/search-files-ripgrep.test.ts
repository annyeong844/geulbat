import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';

import {
  fromRipgrepFsPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';
import {
  isRipgrepBinaryCompatibleWithRoot,
  resolveRipgrepPath,
} from './search-files-ripgrep.js';

void test('resolveRipgrepPath finds an accessible ripgrep binary', async () => {
  const rgPath = await resolveRipgrepPath();

  assert.match(rgPath, /rg(?:\.exe)?$/iu);
  await access(rgPath);
});

void test('isRipgrepBinaryCompatibleWithRoot rejects cross-host binary roots', () => {
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('/usr/bin/rg', 'C:\\workspace'),
    false,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('/usr/bin/rg', '/tmp/workspace'),
    true,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('C:\\tools\\rg.exe', 'C:\\workspace'),
    true,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('C:\\tools\\rg.exe', '/mnt/c/workspace'),
    true,
  );
  assert.equal(
    isRipgrepBinaryCompatibleWithRoot('C:\\tools\\rg.exe', '/tmp/workspace'),
    false,
  );
});

void test('fromRipgrepFsPath keeps native Windows paths for Windows workspaces', () => {
  assert.equal(
    fromRipgrepFsPath(
      'C:\\workspace\\docs\\note.md',
      'C:\\tools\\rg.exe',
      'C:\\workspace',
    ),
    'C:\\workspace\\docs\\note.md',
  );
});

void test('fromRipgrepFsPath converts Windows ripgrep paths for WSL workspaces', () => {
  assert.equal(
    fromRipgrepFsPath(
      'C:\\workspace\\docs\\note.md',
      'C:\\tools\\rg.exe',
      '/mnt/c/workspace',
    ),
    '/mnt/c/workspace/docs/note.md',
  );
});

void test('toWorkspaceRelativeSearchPath uses Windows semantics regardless of host OS', () => {
  assert.equal(
    toWorkspaceRelativeSearchPath(
      'C:\\workspace',
      'C:\\workspace\\docs\\note.md',
    ),
    'docs/note.md',
  );
});
