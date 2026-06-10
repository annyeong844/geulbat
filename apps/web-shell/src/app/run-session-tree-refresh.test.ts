import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectTreeRefreshController,
  requestProjectTreeRefresh,
} from './run-session-tree-refresh.js';

void test('requestProjectTreeRefresh coalesces repeated requests while a refresh is in flight', async () => {
  const controller = createProjectTreeRefreshController();
  const resolvers: Array<() => void> = [];
  let loadCount = 0;

  const loadTree = () =>
    new Promise<void>((resolve) => {
      loadCount += 1;
      resolvers.push(resolve);
    });

  const firstRequest = requestProjectTreeRefresh(controller, loadTree);
  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'running');

  const secondRequest = requestProjectTreeRefresh(controller, loadTree);
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
  const controller = createProjectTreeRefreshController();
  const resolvers: Array<() => void> = [];
  let loadCount = 0;

  const loadTree = () =>
    new Promise<void>((resolve) => {
      loadCount += 1;
      resolvers.push(resolve);
    });

  const firstRequest = requestProjectTreeRefresh(controller, loadTree);
  const secondRequest = requestProjectTreeRefresh(controller, loadTree);
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
