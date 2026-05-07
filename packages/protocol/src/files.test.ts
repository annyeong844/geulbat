import assert from 'node:assert/strict';
import test from 'node:test';

import { isFileSaveResponse, isFileTreeResponse } from './files.js';

void test('isFileTreeResponse requires a canonical project id', () => {
  assert.equal(
    isFileTreeResponse({
      projectId: 'workspace',
      tree: [{ name: 'docs', path: 'docs', type: 'directory', children: [] }],
    }),
    true,
  );

  assert.equal(
    isFileTreeResponse({
      projectId: '../escape',
      tree: [{ name: 'docs', path: 'docs', type: 'directory', children: [] }],
    }),
    false,
  );
});

void test('isFileSaveResponse only accepts canonical success payloads', () => {
  assert.equal(
    isFileSaveResponse({
      path: 'docs/ch01.md',
      versionToken: 'token-1',
      totalLines: 12,
      ok: true,
    }),
    true,
  );

  assert.equal(
    isFileSaveResponse({
      path: 'docs/ch01.md',
      versionToken: 'token-1',
      totalLines: 12,
      ok: false,
    }),
    false,
  );
});
