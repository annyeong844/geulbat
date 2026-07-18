import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createComputerFileScope,
  normalizeComputerBrowseRelativePath,
} from './computer-file-scope.js';

void test('createComputerFileScope derives root-relative home and existing shortcuts', () => {
  const scope = createComputerFileScope({
    root: '/computer',
    home: '/computer/Users/sample',
    isDirectory: (path) =>
      path === '/computer/Users/sample/Downloads' ||
      path === '/computer/Users/sample/Documents',
  });

  assert.deepEqual(scope, {
    root: '/computer',
    browseStartPath: 'Users/sample',
    browseShortcuts: [
      { label: '다운로드', path: 'Users/sample/Downloads' },
      { label: '문서', path: 'Users/sample/Documents' },
    ],
  });
});

void test('createComputerFileScope keeps root home as an empty browse path', () => {
  assert.deepEqual(
    createComputerFileScope({
      root: '/computer',
      home: '/computer',
      isDirectory: () => false,
    }),
    { root: '/computer', browseStartPath: '', browseShortcuts: [] },
  );
});

void test('normalizeComputerBrowseRelativePath rejects paths outside the root', () => {
  assert.equal(normalizeComputerBrowseRelativePath(''), '');
  assert.equal(
    normalizeComputerBrowseRelativePath('Users\\Alice\\Documents'),
    'Users/Alice/Documents',
  );
  assert.equal(normalizeComputerBrowseRelativePath('../outside'), undefined);
  assert.equal(
    normalizeComputerBrowseRelativePath('D:\\Users\\Alice'),
    undefined,
  );
  assert.equal(normalizeComputerBrowseRelativePath('/outside'), undefined);
});
