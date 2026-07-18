import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createComputerTreeRefreshController,
  requestComputerTreeRefresh,
} from './run-session-computer-tree-refresh.js';

void test('requestComputerTreeRefresh coalesces repeated requests while a refresh is in flight', async () => {
  const controller = createComputerTreeRefreshController();
  const resolvers: Array<() => void> = [];
  let loadCount = 0;

  const loadTree = () =>
    new Promise<void>((resolve) => {
      loadCount += 1;
      resolvers.push(resolve);
    });

  const firstRequest = requestComputerTreeRefresh(controller, loadTree);
  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'running');

  const secondRequest = requestComputerTreeRefresh(controller, loadTree);
  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'queued');

  const firstResolve = resolvers.shift();
  assert.ok(firstResolve);
  firstResolve();
  await Promise.resolve();

  assert.equal(loadCount, 2);
  assert.equal(controller.readPhase(), 'running');

  const secondResolve = resolvers.shift();
  assert.ok(secondResolve);
  secondResolve();
  await firstRequest;
  await secondRequest;

  assert.equal(loadCount, 2);
  assert.equal(controller.readPhase(), 'idle');
});

void test('clearQueuedRefresh removes only the queued follow-up refresh intent', async () => {
  const controller = createComputerTreeRefreshController();
  const resolvers: Array<() => void> = [];
  let loadCount = 0;

  const loadTree = () =>
    new Promise<void>((resolve) => {
      loadCount += 1;
      resolvers.push(resolve);
    });

  const firstRequest = requestComputerTreeRefresh(controller, loadTree);
  const secondRequest = requestComputerTreeRefresh(controller, loadTree);
  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'queued');

  controller.clearQueuedRefresh();
  assert.equal(controller.readPhase(), 'running');

  const firstResolve = resolvers.shift();
  assert.ok(firstResolve);
  firstResolve();
  await firstRequest;
  await secondRequest;

  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'idle');

  controller.clearQueuedRefresh();
  assert.equal(controller.readPhase(), 'idle');
});
