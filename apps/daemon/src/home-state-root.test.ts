import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHomeStateRoot } from './home-state-root.js';

void test('resolveHomeStateRoot uses an explicit absolute override on every platform', () => {
  assert.equal(
    resolveHomeStateRoot({
      env: { GEULBAT_HOME_STATE_ROOT: '/state/../private/geulbat' },
      homeDirectory: '/workspace/runner',
      platform: 'linux',
    }),
    '/private/geulbat',
  );
});

void test('resolveHomeStateRoot rejects a relative override instead of coupling Home to cwd', () => {
  assert.throws(
    () =>
      resolveHomeStateRoot({
        env: { GEULBAT_HOME_STATE_ROOT: 'relative/home' },
        homeDirectory: '/workspace/runner',
        platform: 'linux',
      }),
    /GEULBAT_HOME_STATE_ROOT must be an absolute path/u,
  );
});

void test('resolveHomeStateRoot uses LocalAppData on Windows', () => {
  assert.equal(
    resolveHomeStateRoot({
      env: { LOCALAPPDATA: 'D:\\Profiles\\runner\\LocalAppData' },
      homeDirectory: 'D:\\Profiles\\runner',
      platform: 'win32',
    }),
    'D:\\Profiles\\runner\\LocalAppData\\Geulbat',
  );
});

void test('resolveHomeStateRoot falls back to the Windows user home deterministically', () => {
  assert.equal(
    resolveHomeStateRoot({
      env: {},
      homeDirectory: 'D:\\Profiles\\runner',
      platform: 'win32',
    }),
    'D:\\Profiles\\runner\\AppData\\Local\\Geulbat',
  );
});

void test('resolveHomeStateRoot uses Application Support on macOS', () => {
  assert.equal(
    resolveHomeStateRoot({
      env: {},
      homeDirectory: '/Users/runner/workspace-user',
      platform: 'darwin',
    }),
    '/Users/runner/workspace-user/Library/Application Support/Geulbat',
  );
});

void test('resolveHomeStateRoot uses XDG state on Linux and other Unix platforms', () => {
  assert.equal(
    resolveHomeStateRoot({
      env: { XDG_STATE_HOME: '/state/runner' },
      homeDirectory: '/home/runner/workspace-user',
      platform: 'linux',
    }),
    '/state/runner/geulbat',
  );
});

void test('resolveHomeStateRoot falls back to the Unix user home', () => {
  assert.equal(
    resolveHomeStateRoot({
      env: {},
      homeDirectory: '/home/runner/workspace-user',
      platform: 'freebsd',
    }),
    '/home/runner/workspace-user/.local/state/geulbat',
  );
});

void test('resolveHomeStateRoot fails clearly when no state base or user home is usable', () => {
  assert.throws(
    () =>
      resolveHomeStateRoot({
        env: {},
        homeDirectory: undefined,
        platform: 'linux',
      }),
    /no usable OS user home directory is available/u,
  );
});
