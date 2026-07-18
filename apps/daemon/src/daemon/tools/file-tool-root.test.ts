import assert from 'node:assert/strict';
import test from 'node:test';

import { FileAccessError } from '../files/file-domain-error.js';
import { PathEscapeError } from '../files/normalize-path.js';
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

void test('absolute file paths are admitted only inside ComputerFileScope', () => {
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
  assert.throws(
    () => resolveComputerFileToolPath(context, '/private/secret.txt'),
    (error: unknown) => error instanceof PathEscapeError,
  );
});

void test('file paths fail closed when ComputerFileScope is unavailable', () => {
  assert.throws(
    () => resolveComputerFileToolPath({ workingDirectory: '' }, 'notes.txt'),
    (error: unknown) =>
      error instanceof FileAccessError && error.code === 'access_denied',
  );
});

void test('an invalid current directory cannot become a second authority root', () => {
  assert.throws(
    () =>
      resolveComputerFileToolPath(
        {
          computerFileRoot: '/computer',
          workingDirectory: '../outside',
        },
        'notes.txt',
      ),
    (error: unknown) => error instanceof PathEscapeError,
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
