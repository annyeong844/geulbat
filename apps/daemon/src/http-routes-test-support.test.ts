import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  getHomeStateRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('route test daemon contexts isolate roots and close host command links', async (t) => {
  const first = createRouteTestDaemonContext();
  const second = createRouteTestDaemonContext();
  const firstHomeStateRoot = getHomeStateRootFromContext(first);
  const firstComputerFileRoot = getComputerFileRootFromContext(first);
  const closeHostCommands = first.hostCommands.closeAll.bind(
    first.hostCommands,
  );
  let hostCommandCloseCalls = 0;
  first.hostCommands.closeAll = async (args) => {
    hostCommandCloseCalls += 1;
    return await closeHostCommands(args);
  };
  t.after(async () => {
    if (hostCommandCloseCalls === 0) {
      await closeHostCommands();
    }
  });

  assert.notEqual(firstHomeStateRoot, getHomeStateRootFromContext(second));
  assert.notEqual(
    firstComputerFileRoot,
    getComputerFileRootFromContext(second),
  );
  assert.notEqual(firstHomeStateRoot, firstComputerFileRoot);

  await withAuthenticatedDaemonServer(async () => {}, {
    daemonContext: first,
  });
  assert.equal(getHomeStateRootFromContext(first), firstHomeStateRoot);
  assert.equal(getComputerFileRootFromContext(first), firstComputerFileRoot);
  assert.equal(hostCommandCloseCalls, 1);
});
