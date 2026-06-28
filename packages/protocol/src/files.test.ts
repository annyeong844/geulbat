import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFileBinaryInputRefResponse,
  isFileReadResponse,
  isFileSaveResponse,
  isFileTreeResponse,
} from './files.js';

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

void test('isFileReadResponse accepts full read payloads without truncation-era fields', () => {
  assert.equal(
    isFileReadResponse({
      path: 'docs/ch01.md',
      content: '# chapter\n',
      versionToken: 'token-1',
      totalLines: 1,
      startLine: 1,
      endLine: 1,
    }),
    true,
  );
});

void test('isFileBinaryInputRefResponse accepts streamed binary upload refs', () => {
  assert.equal(
    isFileBinaryInputRefResponse({
      ok: true,
      contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000000',
      byteLength: 3,
    }),
    true,
  );

  assert.equal(
    isFileBinaryInputRefResponse({
      ok: true,
      contentRef: 'file-binary-input:00000000-0000-0000-0000-000000000000',
      byteLength: '3',
    }),
    false,
  );
});
