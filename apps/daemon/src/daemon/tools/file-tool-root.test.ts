import assert from 'node:assert/strict';
import test from 'node:test';

import { FileAccessError } from '../files/file-domain-error.js';
import { resolveComputerFileToolPath } from './file-tool-root.js';

void test('relative file paths start from cwd but remain computer-root relative', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/computer',
        workingDirectory: 'workspace/writer/repo',
      },
      '../Downloads/xharness.txt',
    ),
    {
      root: 'computer',
      absoluteRoot: '/computer',
      path: 'workspace/writer/Downloads/xharness.txt',
    },
  );
});

void test('absolute file paths are admitted across the host filesystem', () => {
  const context = {
    computerFileRoot: '/computer',
    workingDirectory: 'workspace/writer/repo',
  };

  assert.deepEqual(
    resolveComputerFileToolPath(context, '/computer/Downloads/xharness.txt'),
    {
      root: 'computer',
      absoluteRoot: '/computer',
      path: 'Downloads/xharness.txt',
    },
  );
  assert.deepEqual(resolveComputerFileToolPath(context, '/private/notes.txt'), {
    root: 'computer',
    absoluteRoot: '/computer',
    path: '../private/notes.txt',
  });
});

void test('a global Computer scope admits an absolute path independently of cwd', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/',
        workingDirectory: 'tmp/unrelated-command-start',
      },
      '/home/user/Documents/note.md',
    ),
    {
      root: 'computer',
      absoluteRoot: '/',
      path: 'home/user/Documents/note.md',
    },
  );
});

void test('file paths fail closed when ComputerFileScope is unavailable', () => {
  assert.throws(
    () => resolveComputerFileToolPath({ workingDirectory: '' }, 'notes.txt'),
    (error: unknown) =>
      error instanceof FileAccessError && error.code === 'access_denied',
  );
});

void test('a current directory outside the coordinate base remains usable', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: '/computer',
        workingDirectory: '../outside',
      },
      'notes.txt',
    ),
    {
      root: 'computer',
      absoluteRoot: '/computer',
      path: '../outside/notes.txt',
    },
  );
});

void test('Windows file paths use the same ComputerFileScope contract', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: 'D:\\workspace',
        workingDirectory: 'repo',
      },
      '..\\Downloads\\xharness.txt',
    ),
    {
      root: 'computer',
      absoluteRoot: 'D:\\workspace',
      path: 'Downloads/xharness.txt',
    },
  );
});

void test('Windows absolute paths may select another drive', () => {
  assert.deepEqual(
    resolveComputerFileToolPath(
      {
        computerFileRoot: 'C:\\',
        workingDirectory: 'Users\\Writer',
      },
      'D:\\Archive\\novel.md',
    ),
    {
      root: 'computer',
      absoluteRoot: 'C:\\',
      path: 'D:/Archive/novel.md',
    },
  );
});
