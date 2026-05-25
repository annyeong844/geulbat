import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRouteTestDaemonContext,
  getWorkspaceRootFromContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';

void test('route test daemon contexts isolate project registry roots', async () => {
  const first = createRouteTestDaemonContext();
  const second = createRouteTestDaemonContext();
  const firstRegistryRoot = first.projectRegistry.getProjectRegistryRoot();
  const secondRegistryRoot = second.projectRegistry.getProjectRegistryRoot();

  assert.notEqual(firstRegistryRoot, secondRegistryRoot);
  assert.notEqual(
    getWorkspaceRootFromContext(first),
    getWorkspaceRootFromContext(second),
  );

  await withAuthenticatedDaemonServer(async () => {}, {
    daemonContext: first,
  });
  assert.equal(
    first.projectRegistry.getProjectRegistryRoot(),
    firstRegistryRoot,
  );
});
