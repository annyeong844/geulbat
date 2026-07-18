import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePath } from './normalize-path.js';

void test('normalizePath preserves a Windows absolute path on another drive', () => {
  assert.equal(
    normalizePath('C:\\workspace', 'D:\\Documents\\file.txt'),
    'D:/Documents/file.txt',
  );
});

void test('normalizePath preserves paths outside the coordinate base', () => {
  assert.equal(
    normalizePath('/computer/home', '/var/log/system.log'),
    '../../var/log/system.log',
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

void test('normalizePath treats the filesystem root as a valid global coordinate base', () => {
  assert.equal(
    normalizePath('/', '/home/user/Documents/note.md'),
    'home/user/Documents/note.md',
  );
});
