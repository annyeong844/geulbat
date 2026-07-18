import assert from 'node:assert/strict';
import test from 'node:test';

import { createComputerFileScope } from './computer-file-scope.js';

void test('createComputerFileScope stays unavailable without a host root', () => {
  assert.equal(createComputerFileScope(), undefined);
});

void test('createComputerFileScope tolerates hosts without a home or shortcut directories', () => {
  assert.deepEqual(createComputerFileScope({ root: '/computer' }), {
    root: '/computer',
    browseShortcuts: [],
  });

  assert.deepEqual(
    createComputerFileScope({
      root: '/computer',
      home: '/computer/missing-home',
    }),
    {
      root: '/computer',
      browseStartPath: 'missing-home',
      browseShortcuts: [],
    },
  );
});

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

void test('createComputerFileScope treats root as a coordinate base rather than a sandbox', () => {
  assert.deepEqual(
    createComputerFileScope({
      root: '/computer',
      home: '/Users/Alice',
      isDirectory: (path) => path === '/Users/Alice/Documents',
    }),
    {
      root: '/computer',
      browseStartPath: '../Users/Alice',
      browseShortcuts: [{ label: '문서', path: '../Users/Alice/Documents' }],
    },
  );
});
