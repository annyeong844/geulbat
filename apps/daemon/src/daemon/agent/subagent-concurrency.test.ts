import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunWorkspaceContext } from '../run-workspace-context.js';
import { createRunState } from './runtime/run-state.js';
import { createSubagentAdmissionController } from './subagent-concurrency.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';

function createTestRunState(runId = 'subagent-concurrency-run') {
  return createRunState({
    runId,
    runContext: createRunWorkspaceContext({
      threadId: testThreadId(31),
      projectId: testProjectId(),
      workspaceRoot: '/tmp/workspace',
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

void test('reserveSubagentLaunchSlots allows unlimited background child capacity', () => {
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
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 12);
  if (admission.ok) {
    admission.reservation.release();
  }
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
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
    assert.equal(admission.error, 'maximum 1 concurrent child agents allowed');
    assert.equal(admission.effectiveMax, 1);
  }
});
