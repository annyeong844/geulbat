import test from 'node:test';
import assert from 'node:assert/strict';

import { EPHEMERAL_DAEMON_PORT, readDaemonPort } from './port.js';

void test('an unset PORT asks the OS for a free port', () => {
  // 제품 실행은 포트를 지정하지 않는다. 고정 포트가 점유되어 앱이 아예 열리지
  // 않는 실패를 없애는 것이 이 계약의 목적이다.
  assert.equal(readDaemonPort(undefined), EPHEMERAL_DAEMON_PORT);
});

void test('readDaemonPort uses the port it was given', () => {
  // 개발 흐름은 `scripts/dev-daemon-port.mjs`가 소유한 값을 `PORT`로 넘긴다.
  assert.equal(readDaemonPort('3456'), 3456);
  assert.equal(readDaemonPort('65535'), 65535);
});

void test('readDaemonPort rejects invalid port values', () => {
  // 지정한 포트가 유효하지 않으면 조용히 다른 포트로 넘어가지 않는다.
  assert.throws(() => readDaemonPort('0'), /invalid PORT: 0/);
  assert.throws(() => readDaemonPort('70000'), /invalid PORT: 70000/);
  assert.throws(() => readDaemonPort('abc'), /invalid PORT: abc/);
});
