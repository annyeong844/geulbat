import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createRunContext } from '../run-context.js';
import { createRunState } from './runtime/run-state.js';
import {
  SUBAGENT_BACKGROUND_CAPACITY_ENV,
  createSubagentAdmissionController,
  createSubagentLaunchPromotionController,
  resolveSubagentConcurrencyPolicyFromEnv,
} from './subagent-concurrency.js';
import { createDaemonRuntimeStateStore } from '../runtime-state-store.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../test-support/subagent-model-routing.js';

function createTestRunState(runId = 'subagent-concurrency-run') {
  return createRunState({
    runId,
    runContext: createRunContext({
      threadId: testThreadId(31),
      stateRoot: '/tmp/home-state',
    }),
  });
}

void test('reserveSubagentLaunchSlots transfers one existing batch reservation for a launch', () => {
  const controller = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: 1 },
  });
  const runState = createTestRunState('subagent-concurrency-transfer');
  const batchAdmission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
    transferable: true,
  });
  assert.equal(batchAdmission.ok, true);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 1);
  const [batchReservationId] =
    runState.backgroundChildLaunchReservationIds.values();
  assert.ok(batchReservationId);

  const launchAdmission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
    transferExistingReservation: true,
  });

  assert.equal(launchAdmission.ok, true);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 1);
  assert.equal(
    runState.backgroundChildLaunchReservationIds.has(batchReservationId),
    false,
  );
  if (launchAdmission.ok) {
    launchAdmission.reservation.release();
    launchAdmission.reservation.release();
  }
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
  if (batchAdmission.ok) {
    batchAdmission.reservation.release();
  }
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
});

void test('reserveSubagentLaunchSlots does not transfer another active launch reservation', () => {
  const controller = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: 1 },
  });
  const runState = createTestRunState('subagent-concurrency-no-steal');
  const activeLaunchAdmission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
  });
  assert.equal(activeLaunchAdmission.ok, true);

  const overlappingAdmission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
    transferExistingReservation: true,
  });

  assert.equal(overlappingAdmission.ok, false);
  if (!overlappingAdmission.ok) {
    assert.equal(overlappingAdmission.errorCode, 'too_many_child_runs');
    assert.equal(overlappingAdmission.effectiveMax, 1);
  }
  if (activeLaunchAdmission.ok) {
    activeLaunchAdmission.reservation.release();
  }
});

void test('subagent launch reservations release idempotently', () => {
  const controller = createSubagentAdmissionController();
  const runState = createTestRunState('subagent-concurrency-release');
  const admission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 2,
  });

  assert.equal(admission.ok, true);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 2);
  if (admission.ok) {
    admission.reservation.release();
    admission.reservation.release();
  }
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
});

void test('configured child capacity is isolated between independent root runs', () => {
  const controller = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: 1 },
  });
  const firstRoot = createTestRunState('subagent-concurrency-root-first');
  const secondRoot = createTestRunState('subagent-concurrency-root-second');

  const firstAdmission = controller.reserveSubagentLaunchSlots({
    runState: firstRoot,
    requestedChildren: 1,
  });
  const secondAdmission = controller.reserveSubagentLaunchSlots({
    runState: secondRoot,
    requestedChildren: 1,
  });

  assert.equal(firstAdmission.ok, true);
  assert.equal(secondAdmission.ok, true);

  if (firstAdmission.ok) {
    firstAdmission.reservation.release();
  }
  if (secondAdmission.ok) {
    secondAdmission.reservation.release();
  }
});

void test('configured child capacity is shared by recursive descendants in one run tree', () => {
  const controller = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: 1 },
  });
  const rootRunState = createTestRunState('subagent-concurrency-tree-root');
  const childRunState = createTestRunState('subagent-concurrency-tree-child');
  const rootAdmission = controller.reserveSubagentLaunchSlots({
    runState: rootRunState,
    requestedChildren: 1,
  });
  assert.equal(rootAdmission.ok, true);
  if (!rootAdmission.ok) {
    throw new Error('root admission must succeed');
  }
  rootAdmission.reservation.activate(childRunState);

  const recursiveAdmission = controller.reserveSubagentLaunchSlots({
    runState: childRunState,
    requestedChildren: 1,
  });

  assert.equal(recursiveAdmission.ok, false);
  if (!recursiveAdmission.ok) {
    assert.equal(recursiveAdmission.errorCode, 'too_many_child_runs');
    assert.equal(recursiveAdmission.effectiveMax, 1);
  }
  rootAdmission.reservation.release();
});

void test('reserveSubagentLaunchSlots rejects invalid requested child counts', () => {
  const controller = createSubagentAdmissionController();
  const runState = createTestRunState('subagent-concurrency-invalid-count');

  assert.throws(
    () =>
      controller.reserveSubagentLaunchSlots({
        runState,
        requestedChildren: 0,
      }),
    /invalid subagent requestedChildren: 0/,
  );
});

void test('Ultra reasoning defaults to three active descendants per run tree', () => {
  const controller = createSubagentAdmissionController();
  const runState = createTestRunState('subagent-concurrency-default');
  const admitted = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 3,
    ultraReasoning: true,
  });
  assert.equal(admitted.ok, true);

  const blocked = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
    ultraReasoning: true,
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.effectiveMax, 3);
  }
  if (admitted.ok) {
    admitted.reservation.release();
  }
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
});

void test('ordinary reasoning keeps the configured-unset policy unlimited', () => {
  const controller = createSubagentAdmissionController();
  const runState = createTestRunState('subagent-concurrency-ordinary');
  const admission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 12,
    ultraReasoning: false,
  });

  assert.equal(admission.ok, true);
  if (admission.ok) {
    admission.reservation.release();
  }
});

void test('reserveSubagentLaunchSlots accepts an explicit unlimited policy', () => {
  const controller = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: null },
  });
  const runState = createTestRunState('subagent-concurrency-unlimited');
  for (let index = 0; index < 10; index += 1) {
    runState.backgroundChildRunIds.add(testRunId(`active-child-${index}`));
  }

  const admission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 12,
  });

  assert.equal(admission.ok, true);
  if (admission.ok) {
    admission.reservation.release();
  }
});

void test('reserveSubagentLaunchSlots returns too_many_child_runs when capacity is exceeded', () => {
  const controller = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: 1 },
  });
  const runState = createTestRunState('subagent-concurrency-too-many');
  runState.backgroundChildRunIds.add(testRunId('active-child'));

  const admission = controller.reserveSubagentLaunchSlots({
    runState,
    requestedChildren: 1,
  });

  assert.equal(admission.ok, false);
  if (!admission.ok) {
    assert.equal(admission.errorCode, 'too_many_child_runs');
    assert.equal(
      admission.error,
      'maximum 1 concurrent descendant agents allowed per run tree',
    );
    assert.equal(admission.effectiveMax, 1);
  }
});

void test('capacity release coalesces duplicate promotion wakes and shutdown waits for the one promoted start', async () => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-subagent-promotion-'),
  );
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const admission = createSubagentAdmissionController({
    policy: { maxConcurrentChildren: 1 },
  });
  const promotions = createSubagentLaunchPromotionController({
    admission,
    launchRequests: store,
  });
  const promotedRunState = createTestRunState('promotion-parent');
  const blockingAdmission = admission.reserveSubagentLaunchSlots({
    runState: promotedRunState,
    requestedChildren: 1,
  });
  assert.equal(blockingAdmission.ok, true);
  if (!blockingAdmission.ok) {
    throw new Error('blocking admission must succeed');
  }

  let releasePromotedStart = () => {};
  const promotedStartGate = new Promise<void>((resolve) => {
    releasePromotedStart = resolve;
  });
  let observePromotedStart = () => {};
  const promotedStartObserved = new Promise<void>((resolve) => {
    observePromotedStart = resolve;
  });
  let startCount = 0;

  try {
    const [queued] = store.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-promote-on-capacity-release',
        task: 'run after capacity is released',
        subagentType: 'explorer',
        capabilities: [],
        parentRunId: testRunId('promotion-parent'),
        ownerThreadId: testThreadId(31),
        stateRoot: homeStateRoot,
        workingDirectory: homeStateRoot,
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(queued);
    promotions.deferLaunch({
      registration: {
        childRunId: queued.childRunId,
        ultraReasoning: false,
        parentRunState: promotedRunState,
        async start() {
          startCount += 1;
          const transferredAdmission = admission.reserveSubagentLaunchSlots({
            runState: promotedRunState,
            requestedChildren: 1,
            transferExistingReservation: true,
          });
          assert.equal(transferredAdmission.ok, true);
          if (!transferredAdmission.ok) {
            throw new Error('promoted reservation transfer must succeed');
          }
          store.markSubagentLaunchStarting(queued.childRunId);
          transferredAdmission.reservation.activate(
            createTestRunState('promotion-child'),
          );
          observePromotedStart();
          await promotedStartGate;
          store.markSubagentLaunchStarted(queued.childRunId);
          transferredAdmission.reservation.release();
        },
      },
      deferReason: 'configured_capacity',
    });

    promotions.requestPromotion();
    promotions.requestPromotion();
    await delay(0);
    assert.equal(startCount, 0);

    blockingAdmission.reservation.release();
    await promotedStartObserved;
    promotions.requestPromotion();
    promotions.requestPromotion();

    let closeSettled = false;
    const firstClose = promotions.close();
    const joinedClose = promotions.close();
    assert.equal(joinedClose, firstClose);
    const closePromise = firstClose.then(() => {
      closeSettled = true;
    });
    await delay(0);
    assert.equal(closeSettled, false);

    releasePromotedStart();
    await Promise.all([closePromise, joinedClose]);
    assert.equal(startCount, 1);
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.launchState,
      'started',
    );
  } finally {
    await promotions.close();
    blockingAdmission.reservation.release();
    store.close();
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});

void test('resolveSubagentConcurrencyPolicyFromEnv returns undefined when env is absent', () => {
  assert.equal(resolveSubagentConcurrencyPolicyFromEnv({}), undefined);
});
void test('resolveSubagentConcurrencyPolicyFromEnv accepts trimmed capacity values', () => {
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: ' 1 ',
    }),
    { maxConcurrentChildren: 1 },
  );
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: '128',
    }),
    { maxConcurrentChildren: 128 },
  );
  assert.deepEqual(
    resolveSubagentConcurrencyPolicyFromEnv({
      [SUBAGENT_BACKGROUND_CAPACITY_ENV]: 'unlimited',
    }),
    { maxConcurrentChildren: null },
  );
});
void test('resolveSubagentConcurrencyPolicyFromEnv rejects invalid capacity values', () => {
  const invalidValues = [
    '',
    ' ',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    'NaN',
    'Infinity',
    '9007199254740992',
  ];

  for (const value of invalidValues) {
    assert.throws(
      () =>
        resolveSubagentConcurrencyPolicyFromEnv({
          [SUBAGENT_BACKGROUND_CAPACITY_ENV]: value,
        }),
      new RegExp(`invalid ${SUBAGENT_BACKGROUND_CAPACITY_ENV}`),
    );
  }
});
