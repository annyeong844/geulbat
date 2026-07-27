import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDaemonShellUrl,
  discoverRunningDaemonShell,
} from './daemon-shell-discovery.js';

void test('a live daemon that recorded its port is discoverable', async () => {
  const discovered = await discoverRunningDaemonShell({
    readLockOwner: async () => ({ pid: 4242, port: 41234 }),
    isProcessAlive: (pid) => pid === 4242,
  });

  assert.deepEqual(discovered, {
    pid: 4242,
    url: 'http://127.0.0.1:41234/',
  });
});

void test('no lock means no daemon to open', async () => {
  const discovered = await discoverRunningDaemonShell({
    readLockOwner: async () => null,
    isProcessAlive: () => true,
  });

  assert.equal(discovered, null);
});

void test('a lock without a recorded port is not yet openable', async () => {
  // lock은 listen 전에 잡힌다. 그 창에서는 주소가 아직 없다.
  const discovered = await discoverRunningDaemonShell({
    readLockOwner: async () => ({ pid: 4242 }),
    isProcessAlive: () => true,
  });

  assert.equal(discovered, null);
});

void test('a lock left behind by a dead daemon is not openable', async () => {
  // 죽은 데몬의 주소를 돌려주면 CLI가 열리지 않는 창을 띄운다.
  const discovered = await discoverRunningDaemonShell({
    readLockOwner: async () => ({ pid: 4242, port: 41234 }),
    isProcessAlive: () => false,
  });

  assert.equal(discovered, null);
});

void test('the shell url targets loopback because the daemon binds there', () => {
  assert.equal(buildDaemonShellUrl(3456), 'http://127.0.0.1:3456/');
  assert.equal(buildDaemonShellUrl(41234), 'http://127.0.0.1:41234/');
});
