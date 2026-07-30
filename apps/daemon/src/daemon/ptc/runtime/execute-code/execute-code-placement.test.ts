import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnusedPlacementDependencies } from '../../../../test-support/ptc-execute-code-placement.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { createPtcExecuteCodePlacementCoordinator } from './execute-code-placement.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  classifyPtcExecuteCodeWarmPlacementDecision,
  createPtcExecuteCodeCallbackEffectPolicy,
  isPtcExecuteCodePlacementBurstEligible,
  readPtcExecuteCodePlacementObservation,
  readPtcExecuteCodePlacementPreflightRecord,
  readPtcExecuteCodePlacementDecision,
} from './execute-code-placement-contract.js';
import type { PtcSessionDockerManager } from '../../lab/session/session-docker-contract.js';

void test('classifyPtcExecuteCodePlacementContinuity fails closed without an independence proof', () => {
  const unclassified = classifyPtcExecuteCodePlacementContinuity();
  assert.deepEqual(unclassified, {
    kind: 'defer_to_warm',
    reason: 'unclassified',
  });
  assert.equal(isPtcExecuteCodePlacementBurstEligible(unclassified), false);

  const independent = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'read_only_analysis' },
  });
  assert.deepEqual(independent, {
    kind: 'independent',
    reason: 'read_only_analysis',
  });
  assert.equal(isPtcExecuteCodePlacementBurstEligible(independent), true);
});

void test('classifyPtcExecuteCodePlacementContinuity keeps proven warm dependency dominant', () => {
  const classified = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'self_contained' },
    policyFailClosed: true,
    warmHandles: [{ handleId: 'warm-handle-1', kind: 'warm_fs' }],
  });

  assert.deepEqual(classified, {
    kind: 'requires_warm_continuity',
    handleId: 'warm-handle-1',
    reason: 'warm_fs',
  });
  assert.equal(isPtcExecuteCodePlacementBurstEligible(classified), false);
});

void test('classifyPtcExecuteCodeWarmPlacementDecision names why warm remains selected', () => {
  assert.deepEqual(
    classifyPtcExecuteCodeWarmPlacementDecision({
      kind: 'requires_warm_continuity',
      handleId: 'warm-handle-1',
      reason: 'warm_fs',
    }),
    {
      selectedLane: 'warm_session',
      reason: 'warm_continuity_required',
    },
  );

  assert.deepEqual(
    classifyPtcExecuteCodeWarmPlacementDecision({
      kind: 'defer_to_warm',
      reason: 'unclassified',
    }),
    {
      selectedLane: 'warm_session',
      reason: 'independence_not_proven',
    },
  );

  assert.deepEqual(
    classifyPtcExecuteCodeWarmPlacementDecision({
      kind: 'independent',
      reason: 'self_contained',
    }),
    {
      selectedLane: 'warm_session',
      reason: 'burst_not_enabled_yet',
    },
  );
});

void test('createPtcExecuteCodePlacementCoordinator keeps warm session dependencies unchanged', async () => {
  const identity = {
    threadId: testThreadId(940),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const signal = new AbortController().signal;
  const continuity = classifyPtcExecuteCodePlacementContinuity();
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 2,
  });
  const resourceSnapshotRef = {
    snapshotId: 'resource-snapshot-placement-test',
    source: 'agent_resource_budget_provider',
  } as const;

  const coordinator = createPtcExecuteCodePlacementCoordinator();
  assert.deepEqual(coordinator.readPressureSnapshot?.(), {
    shutdownState: 'open',
    activeWarmPlacementCount: 0,
    retainedWarmPlacementCount: 0,
    warmTransitionCount: 0,
    activeBurstPlacementCount: 0,
    coldCreateBurstPlacementCount: 0,
    standbyRestoreBurstPlacementCount: 0,
    burstCleanupCount: 0,
    queuedWarmPlacementCount: 0,
    queuedBurstPlacementCount: 0,
    queuedBurstThreadCount: 0,
    standbyPoolState: 'disabled',
    standbyReadySlotCount: 0,
    standbyRefillInFlightCount: 0,
    standbyIdentityCount: 0,
  });
  const placementResult = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
    resourceSnapshotRef,
    signal,
  });
  assert.equal(placementResult.ok, true);
  if (!placementResult.ok || 'queued' in placementResult) {
    return;
  }
  const placement = placementResult.value;

  assert.equal(placement.kind, 'warm_session');
  assert.match(placement.lease.leaseId, /^ptc_warm_lease_/u);
  assert.equal(placement.lease.generation, 1);
  assert.equal(placement.lease.shutdownEpoch, 0);
  assert.equal(placement.lease.ownerThreadId, identity.threadId);
  assert.equal(placement.executionKind, 'batch_command');
  assert.equal(placement.continuity, continuity);
  const batchObservation = readPtcExecuteCodePlacementObservation(placement);
  assert.deepEqual(batchObservation, {
    executionKind: 'batch_command',
    continuity,
    callbackEffectPolicy,
    burstEligible: false,
    selectedLane: 'warm_session',
    reason: 'independence_not_proven',
    resourceSnapshotRef,
  });
  const batchWarmDecision =
    readPtcExecuteCodePlacementDecision(batchObservation);
  assert.deepEqual(readPtcExecuteCodePlacementPreflightRecord(placement), {
    input: batchObservation,
    placementDecision: batchWarmDecision,
    burstEligible: false,
    selectedLane: 'warm_session',
    reason: 'independence_not_proven',
    resourceSnapshotRef,
  });
  assert.equal('cellId' in placement, false);
  assert.equal(placement.identity, identity);
  assert.equal(placement.sessionManager, sessionManager);
  assert.equal(placement.batchRunner, batchRunner);
  assert.equal(
    coordinator.readPressureSnapshot?.().activeWarmPlacementCount,
    1,
  );
  assert.equal(
    coordinator.readPressureSnapshot?.().retainedWarmPlacementCount,
    1,
  );
  await coordinator.releasePlacement(placement);
  assert.equal(
    coordinator.readPressureSnapshot?.().activeWarmPlacementCount,
    0,
  );
  assert.equal(
    coordinator.readPressureSnapshot?.().retainedWarmPlacementCount,
    1,
  );

  const independent = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'self_contained' },
  });
  const cellPlacementResult = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_placement_observation',
    continuity: independent,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
    signal,
  });
  assert.equal(cellPlacementResult.ok, true);
  if (!cellPlacementResult.ok || 'queued' in cellPlacementResult) {
    return;
  }
  const cellPlacement = cellPlacementResult.value;

  assert.equal(cellPlacement.kind, 'warm_session');
  assert.equal(cellPlacement.lease.generation, 2);
  assert.equal(cellPlacement.executionKind, 'detached_cell');
  assert.equal(cellPlacement.cellId, 'ptc_cell_placement_observation');
  assert.equal(cellPlacement.continuity, independent);
  const cellObservation = readPtcExecuteCodePlacementObservation(cellPlacement);
  assert.deepEqual(cellObservation, {
    executionKind: 'detached_cell',
    cellId: 'ptc_cell_placement_observation',
    continuity: independent,
    callbackEffectPolicy,
    burstEligible: true,
    selectedLane: 'warm_session',
    reason: 'burst_not_enabled_yet',
  });
  const cellWarmDecision = readPtcExecuteCodePlacementDecision(cellObservation);
  assert.deepEqual(readPtcExecuteCodePlacementPreflightRecord(cellPlacement), {
    input: cellObservation,
    placementDecision: cellWarmDecision,
    burstEligible: true,
    selectedLane: 'warm_session',
    reason: 'burst_not_enabled_yet',
  });
  await coordinator.releasePlacement(cellPlacement);
  coordinator.beginShutdown();
  assert.equal(coordinator.readPressureSnapshot?.().shutdownState, 'closing');
  coordinator.finishShutdown();
  assert.deepEqual(coordinator.readPressureSnapshot?.(), {
    shutdownState: 'closed',
    activeWarmPlacementCount: 0,
    retainedWarmPlacementCount: 0,
    warmTransitionCount: 0,
    activeBurstPlacementCount: 0,
    coldCreateBurstPlacementCount: 0,
    standbyRestoreBurstPlacementCount: 0,
    burstCleanupCount: 0,
    queuedWarmPlacementCount: 0,
    queuedBurstPlacementCount: 0,
    queuedBurstThreadCount: 0,
    standbyPoolState: 'disabled',
    standbyReadySlotCount: 0,
    standbyRefillInFlightCount: 0,
    standbyIdentityCount: 0,
  });
});

void test('warm placement owns one active main lease globally and rejects a second thread visibly', async () => {
  const identity = {
    threadId: testThreadId(940_1),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const otherIdentity = { ...identity, threadId: testThreadId(940_2) };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const unclassified = classifyPtcExecuteCodePlacementContinuity();
  const independent = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'self_contained' },
  });
  const coordinator = createPtcExecuteCodePlacementCoordinator();

  const first = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_placement_owner',
    continuity: unclassified,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(first.ok, true);
  if (!first.ok || 'queued' in first) {
    return;
  }

  const otherThread = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity: independent,
    callbackEffectPolicy,
    identity: otherIdentity,
    sessionManager,
    batchRunner,
  });
  assert.equal(otherThread.ok, false);
  if (otherThread.ok) {
    return;
  }
  assert.equal(otherThread.reasonCode, 'ptc_lab_session_busy');
  assert.equal(otherThread.diagnostics.activeCellId, first.value.cellId);

  const concurrent = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity: independent,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.deepEqual(concurrent, {
    ok: false,
    reasonCode: 'ptc_lab_session_busy',
    message: 'PTC warm session already has an active placement lease',
    remediation:
      'Wait for the active exec cell to settle before retrying; cold burst placement is not enabled.',
    diagnostics: {
      placementLane: 'warm_session',
      placementOwnerKind: 'root_main',
      activeExecutionKind: 'detached_cell',
      activeLeaseGeneration: 1,
      burstEligible: true,
      coldBurstAvailable: false,
      activeCellId: 'ptc_cell_placement_owner',
    },
  });

  await coordinator.releasePlacement(first.value);
});

void test('warm placement closes the retained main before switching thread identity', async () => {
  const firstIdentity = {
    threadId: testThreadId(940_21),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const secondIdentity = {
    ...firstIdentity,
    threadId: testThreadId(940_22),
  };
  const closedThreadIds: string[] = [];
  const sessionManager = {
    async getOrCreate() {
      throw new Error('not used by placement acquisition');
    },
    async close(closedIdentity) {
      closedThreadIds.push(closedIdentity.threadId);
      return { ok: true, value: undefined } as const;
    },
    async closeAll() {
      return { ok: true, value: undefined } as const;
    },
  } satisfies PtcSessionDockerManager;
  const { batchRunner } = createUnusedPlacementDependencies();
  const coordinator = createPtcExecuteCodePlacementCoordinator();
  const continuity = classifyPtcExecuteCodePlacementContinuity();
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const acquire = (identity: typeof firstIdentity) =>
    coordinator.acquirePlacement({
      kind: 'batch_command',
      ownerKind: 'root_main',
      continuity,
      callbackEffectPolicy,
      identity,
      sessionManager,
      batchRunner,
    });

  const first = await acquire(firstIdentity);
  assert.equal(first.ok && !('queued' in first), true);
  if (!first.ok || 'queued' in first) {
    return;
  }
  await coordinator.releasePlacement(first.value);

  const second = await acquire(secondIdentity);
  assert.equal(second.ok && !('queued' in second), true);
  assert.deepEqual(closedThreadIds, [firstIdentity.threadId]);
  if (second.ok && !('queued' in second)) {
    await coordinator.releasePlacement(second.value);
  }
});

void test('warm placement ignores stale and duplicate release without freeing a newer generation', async () => {
  const identity = {
    threadId: testThreadId(940_3),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const continuity = classifyPtcExecuteCodePlacementContinuity();
  const coordinator = createPtcExecuteCodePlacementCoordinator();
  const acquire = () =>
    coordinator.acquirePlacement({
      kind: 'batch_command',
      ownerKind: 'root_main',
      continuity,
      callbackEffectPolicy,
      identity,
      sessionManager,
      batchRunner,
    });

  const first = await acquire();
  assert.equal(first.ok, true);
  if (!first.ok || 'queued' in first) {
    return;
  }
  assert.equal(first.value.lease.generation, 1);
  await coordinator.releasePlacement(first.value);

  const second = await acquire();
  assert.equal(second.ok, true);
  if (!second.ok || 'queued' in second) {
    return;
  }
  assert.equal(second.value.lease.generation, 2);

  await coordinator.releasePlacement(first.value);
  const stillBusy = await acquire();
  assert.equal(stillBusy.ok, false);
  if (stillBusy.ok) {
    return;
  }
  assert.equal(stillBusy.reasonCode, 'ptc_lab_session_busy');
  assert.equal(stillBusy.diagnostics.activeLeaseGeneration, 2);

  await coordinator.releasePlacement(second.value);
  await coordinator.releasePlacement(second.value);
  const third = await acquire();
  assert.equal(third.ok, true);
  if (!third.ok || 'queued' in third) {
    return;
  }
  assert.equal(third.value.lease.generation, 3);
  await coordinator.releasePlacement(third.value);
});

void test('warm placement rejects aborted and shutdown-fenced acquisition without consuming capacity', async () => {
  const identity = {
    threadId: testThreadId(940_4),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const continuity = classifyPtcExecuteCodePlacementContinuity();
  const coordinator = createPtcExecuteCodePlacementCoordinator();
  const aborted = new AbortController();
  aborted.abort();

  assert.deepEqual(
    await coordinator.acquirePlacement({
      kind: 'batch_command',
      ownerKind: 'root_main',
      continuity,
      callbackEffectPolicy,
      identity,
      sessionManager,
      batchRunner,
      signal: aborted.signal,
    }),
    {
      ok: false,
      reasonCode: 'ptc_lab_command_cancelled',
      message: 'PTC placement acquisition was cancelled',
      diagnostics: {
        abortedBeforeAcquire: true,
        ownerThreadId: identity.threadId,
      },
    },
  );

  const active = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(active.ok, true);
  if (!active.ok || 'queued' in active) {
    return;
  }
  assert.equal(active.value.lease.generation, 1);

  coordinator.beginShutdown();
  const closingIdentity = { ...identity, threadId: testThreadId(940_5) };
  const closing = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity,
    callbackEffectPolicy,
    identity: closingIdentity,
    sessionManager,
    batchRunner,
  });
  assert.equal(closing.ok, false);
  if (closing.ok) {
    return;
  }
  assert.equal(closing.reasonCode, 'ptc_lab_session_unavailable');
  assert.deepEqual(closing.diagnostics, {
    placementShutdownState: 'closing',
    shutdownEpoch: 1,
    ownerThreadId: closingIdentity.threadId,
  });

  await coordinator.releasePlacement(active.value);
  coordinator.finishShutdown();
  const closed = await coordinator.acquirePlacement({
    kind: 'batch_command',
    ownerKind: 'root_main',
    continuity,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(closed.ok, false);
  if (closed.ok) {
    return;
  }
  assert.deepEqual(closed.diagnostics, {
    placementShutdownState: 'closed',
    shutdownEpoch: 1,
    ownerThreadId: identity.threadId,
  });
});
