import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fromRipgrepFsPath,
  toWorkspaceRelativeSearchPath,
} from './search-files-ripgrep-paths.js';

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
