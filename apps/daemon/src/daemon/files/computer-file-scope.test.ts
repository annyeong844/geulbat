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

void test('createComputerFileScope does not invent shortcuts from guessed home folder names', () => {
  const scope = createComputerFileScope({
    root: '/computer',
    home: '/computer/Users/sample',
  });

  assert.deepEqual(scope, {
    root: '/computer',
    browseStartPath: 'Users/sample',
    browseShortcuts: [],
  });
});

void test('createComputerFileScope projects discovered host locations into the existing shortcut contract', () => {
  const scope = createComputerFileScope({
    root: '/',
    home: '/Users/Alice',
    browseLocations: [
      { label: 'WSL', path: '/' },
      { label: 'Windows (F:)', path: '/mnt/f' },
      { label: 'duplicate F', path: '/mnt/f' },
    ],
  });

  assert.deepEqual(scope, {
    root: '/',
    browseStartPath: 'Users/Alice',
    browseShortcuts: [
      { label: 'WSL', path: '' },
      { label: 'Windows (F:)', path: 'mnt/f' },
    ],
  });
});

void test('createComputerFileScope keeps root home as an empty browse path', () => {
  assert.deepEqual(
    createComputerFileScope({
      root: '/computer',
      home: '/computer',
    }),
    { root: '/computer', browseStartPath: '', browseShortcuts: [] },
  );
});

void test('createComputerFileScope treats root as a coordinate base rather than a sandbox', () => {
  assert.deepEqual(
    createComputerFileScope({
      root: '/computer',
      home: '/Users/Alice',
    }),
    {
      root: '/computer',
      browseStartPath: '../Users/Alice',
      browseShortcuts: [],
    },
  );
});
