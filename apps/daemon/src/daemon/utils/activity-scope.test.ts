import assert from 'node:assert/strict';
import test from 'node:test';

import { currentActivity, withActivityScope } from './activity-scope.js';

void test('no scope means the daemon itself is the owner', () => {
  assert.equal(currentActivity(), undefined);
});

void test('a tool scope inside a run scope answers both', () => {
  withActivityScope({ runId: 'run-1', threadId: 'thread-1' }, () => {
    withActivityScope({ toolName: 'exec_command', callId: 'call-1' }, () => {
      assert.deepEqual(currentActivity(), {
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'exec_command',
        callId: 'call-1',
      });
    });
    // 안쪽 스코프를 벗어나면 도구는 사라지고 run은 남는다.
    assert.deepEqual(currentActivity(), {
      runId: 'run-1',
      threadId: 'thread-1',
    });
  });
  assert.equal(currentActivity(), undefined);
});

void test('the scope follows the work across awaits', async () => {
  await withActivityScope({ runId: 'run-2' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(currentActivity(), { runId: 'run-2' });
  });
});

void test('concurrent runs do not read each other', async () => {
  const observed: Array<string | undefined> = [];
  const one = withActivityScope({ runId: 'run-a' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    observed.push(currentActivity()?.runId);
  });
  const two = withActivityScope({ runId: 'run-b' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    observed.push(currentActivity()?.runId);
  });
  await Promise.all([one, two]);
  assert.deepEqual(observed, ['run-b', 'run-a']);
});

void test('a detached launch keeps the scope of where it was launched', async () => {
  let observed: string | undefined;
  const settled = new Promise<void>((resolve) => {
    withActivityScope({ runId: 'run-c', toolName: 'ptc_execute_code' }, () => {
      // 분리 실행 — 호출자는 기다리지 않는다. 그래도 소유자는 따라간다.
      void (async () => {
        await new Promise((r) => setTimeout(r, 1));
        observed = currentActivity()?.toolName;
        resolve();
      })();
    });
  });
  await settled;
  assert.equal(observed, 'ptc_execute_code');
});
