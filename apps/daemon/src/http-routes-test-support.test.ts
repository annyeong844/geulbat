import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRouteTestDaemonContext,
  getComputerFileRootFromContext,
  getHomeStateRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('route test daemon contexts isolate Home and Computer roots', async () => {
  const first = createRouteTestDaemonContext();
  const second = createRouteTestDaemonContext();
  const firstHomeStateRoot = getHomeStateRootFromContext(first);
  const firstComputerFileRoot = getComputerFileRootFromContext(first);

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
});
