import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_DAEMON_PORT, readDaemonPort } from './port.js';

void test('readDaemonPort falls back to the default daemon port', () => {
  assert.equal(readDaemonPort(undefined), DEFAULT_DAEMON_PORT);
});

void test('readDaemonPort accepts canonical numeric ports', () => {
  assert.equal(readDaemonPort('3456'), 3456);
  assert.equal(readDaemonPort('65535'), 65535);
});

void test('readDaemonPort rejects invalid port values', () => {
  assert.throws(() => readDaemonPort('0'), /invalid PORT: 0/);
  assert.throws(() => readDaemonPort('70000'), /invalid PORT: 70000/);
  assert.throws(() => readDaemonPort('abc'), /invalid PORT: abc/);
});
