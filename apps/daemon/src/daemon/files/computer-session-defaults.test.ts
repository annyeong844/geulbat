import test from 'node:test';
import assert from 'node:assert/strict';

import { detectComputerSessionDefaults } from './computer-session-defaults.js';

const WINDOWS_USERS_ROOT = '/mnt/c/' + 'Users';

void test('WSL keeps the matching Windows profile as the start inside a global Computer scope', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/mnt/c',
        WINDOWS_USERS_ROOT,
        `${WINDOWS_USERS_ROOT}/CodexSandboxOffline`,
        `${WINDOWS_USERS_ROOT}/Writer`,
      ].includes(path),
    listDirectory: (path) =>
      path === WINDOWS_USERS_ROOT
        ? ['CodexSandboxOffline', 'Public', 'Writer']
        : [],
    exists: (path) =>
      [
        `${WINDOWS_USERS_ROOT}/CodexSandboxOffline/NTUSER.DAT`,
        `${WINDOWS_USERS_ROOT}/Writer/NTUSER.DAT`,
      ].includes(path),
    homeDirectory: () => '/workspace/Writer',
  });
  assert.deepEqual(detected, {
    root: '/',
    home: `${WINDOWS_USERS_ROOT}/Writer`,
  });
});

void test('WSL does not guess a home from unrelated valid profiles', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/mnt/c',
        WINDOWS_USERS_ROOT,
        `${WINDOWS_USERS_ROOT}/Alice`,
        `${WINDOWS_USERS_ROOT}/Bob`,
      ].includes(path),
    listDirectory: () => ['Alice', 'Bob'],
    exists: (path) => path.endsWith('/NTUSER.DAT'),
    homeDirectory: () => '/workspace/daemon',
  });
  assert.deepEqual(detected, { root: '/', home: '/workspace/daemon' });
});

void test('WSL without a detectable Windows user starts from the Linux home', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) => ['/mnt/c', WINDOWS_USERS_ROOT].includes(path),
    listDirectory: () => ['Public'],
    exists: () => false,
    homeDirectory: () => '/home/user',
  });
  assert.deepEqual(detected, { root: '/', home: '/home/user' });
});

void test('native POSIX platforms expose the global Computer scope and start at home', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: () => false,
    homeDirectory: () => '/workspace/runner-home',
  });
  assert.deepEqual(detected, {
    root: '/',
    home: '/workspace/runner-home',
  });
});
