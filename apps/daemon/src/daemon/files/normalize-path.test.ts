import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkNoSymlinkPathSegments,
  PathNotFoundError,
  PathEscapeError,
  normalizePath,
} from './normalize-path.js';

void test('checkNoSymlinkPathSegments surfaces missing source paths when missing leaf is not allowed', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-normalize-'));

  await assert.rejects(
    () =>
      checkNoSymlinkPathSegments(
        workspaceRoot,
        join(workspaceRoot, 'missing.txt'),
      ),
    (error: unknown) =>
      error instanceof PathNotFoundError &&
      error.code === 'not_found' &&
      error.path === 'missing.txt',
  );
});

void test('checkNoSymlinkPathSegments allows missing tails for create-like paths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-normalize-'));

  await assert.doesNotReject(() =>
    checkNoSymlinkPathSegments(
      workspaceRoot,
      join(workspaceRoot, 'drafts', 'chapter-1.md'),
      {
        allowMissingLeaf: true,
      },
    ),
  );
});

void test('normalizePath rejects Windows-form absolute paths on a different drive', () => {
  assert.throws(
    () => normalizePath('C:\\workspace', 'D:\\secrets\\file.txt'),
    (error: unknown) => error instanceof PathEscapeError,
  );
});

void test('normalizePath accepts Windows-form paths within the same root regardless of drive-letter casing', () => {
  assert.equal(
    normalizePath(
      'C:\\Users\\User\\Workspace',
      'c:\\users\\user\\workspace\\notes\\todo.md',
    ),
    'notes/todo.md',
  );
});
