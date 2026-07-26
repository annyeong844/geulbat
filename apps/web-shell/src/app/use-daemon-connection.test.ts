import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { useDaemonConnection } from './use-daemon-connection.js';
import { installFetchSequence, renderHook } from '../test-support/hook-test.js';

let restoreFetch = () => {};

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
});

void test('useDaemonConnection reports one recovery only after a failed probe', async () => {
  let recoveryCount = 0;
  const fetchMock = installFetchSequence(
    () => new Response(null, { status: 200 }),
    () => {
      throw new Error('daemon unavailable');
    },
    () => new Response(null, { status: 200 }),
    () => new Response(null, { status: 200 }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useDaemonConnection, {
    onRecovered: () => {
      recoveryCount += 1;
    },
  });

  assert.equal(hook.result.current.state, 'connected');
  assert.equal(recoveryCount, 0);

  await hook.run((current) => current.reconnect());
  await hook.flush();
  assert.equal(hook.result.current.state, 'reconnecting');
  assert.equal(recoveryCount, 0);

  await hook.run((current) => current.reconnect());
  await hook.flush();
  assert.equal(hook.result.current.state, 'connected');
  assert.equal(recoveryCount, 1);

  await hook.run((current) => current.reconnect());
  await hook.flush();
  assert.equal(hook.result.current.state, 'connected');
  assert.equal(recoveryCount, 1);
  assert.deepEqual(
    fetchMock.calls.map((call) => call.url),
    ['/api/health', '/api/health', '/api/health', '/api/health'],
  );
  hook.unmount();
});
