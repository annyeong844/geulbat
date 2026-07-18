import test from 'node:test';
import assert from 'node:assert/strict';
import { testThreadId } from '../../../../test-support/thread-id.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  createPtcExecuteCodeCallbackEffectPolicy,
  createPtcExecuteCodePlacementCoordinator,
  readPtcExecuteCodePlacementObservation,
  resolvePtcExecuteCodeBurstPlacementConfigFromEnv,
  type PtcExecuteCodePlacementBatchRunner,
} from './execute-code-placement.js';
import type { PtcSessionDockerManager } from '../../lab/session/session-docker-contract.js';

function createUnusedPlacementDependencies() {
  const sessionManager = {
    async getOrCreate() {
      throw new Error('not used by placement acquisition');
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return { ok: true, value: undefined };
    },
  } satisfies PtcSessionDockerManager;
  const batchRunner = {
    async runPtcLabSessionBatchCommand() {
      throw new Error('not used by placement acquisition');
    },
  } satisfies PtcExecuteCodePlacementBatchRunner;
  return { sessionManager, batchRunner };
}

function createResourceAdmission(maxActiveExecutions: number) {
  return {
    placementResourceBudgetProvider: () => ({
      resourceSnapshotRef: {
        snapshotId: `resource-capacity-${maxActiveExecutions}`,
        source: 'agent_resource_budget_provider' as const,
      },
      availableParallelism: { ok: true as const, value: maxActiveExecutions },
      constrainedMemoryBytes: {
        ok: true as const,
        value: maxActiveExecutions,
      },
      availableMemoryBytes: {
        ok: true as const,
        value: maxActiveExecutions,
      },
    }),
    resourceRequirements: { cpuUnits: 1, memoryBytes: 1 },
  };
}

void test('burst placement config is explicit and rejects legacy fixed concurrency caps', () => {
  assert.equal(resolvePtcExecuteCodeBurstPlacementConfigFromEnv({}), undefined);
  assert.deepEqual(
    resolvePtcExecuteCodeBurstPlacementConfigFromEnv({
      GEULBAT_PTC_BURST_ENABLED: 'false',
    }),
    { enabled: false },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeBurstPlacementConfigFromEnv({
      GEULBAT_PTC_BURST_ENABLED: 'true',
    }),
    { enabled: true },
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeBurstPlacementConfigFromEnv({
        GEULBAT_PTC_BURST_PER_IDENTITY_CONCURRENCY: '2',
      }),
    /fixed burst concurrency settings are no longer supported/u,
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeBurstPlacementConfigFromEnv({
        GEULBAT_PTC_BURST_GLOBAL_CONCURRENCY: '4',
      }),
    /fixed burst concurrency settings are no longer supported/u,
  );
});

void test('resource-starved independent work queues instead of cold-creating another burst', async () => {
  const identity = {
    threadId: testThreadId(940_5),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    placementResourceBudgetProvider: () => ({
      resourceSnapshotRef: {
        snapshotId: 'resource-starved',
        source: 'agent_resource_budget_provider',
      },
      availableParallelism: { ok: true, value: 1 },
      constrainedMemoryBytes: { ok: true, value: 100 },
      availableMemoryBytes: { ok: true, value: 100 },
    }),
    resourceRequirements: { cpuUnits: 2, memoryBytes: 200 },
  });
  const result = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_resource_starved',
    continuity: classifyPtcExecuteCodePlacementContinuity({
      independenceProof: { reason: 'read_only_analysis' },
    }),
    callbackEffectPolicy: createPtcExecuteCodeCallbackEffectPolicy({
      callbackToolCount: 0,
    }),
    identity,
    sessionManager,
    batchRunner,
  });

  if (result.ok && !('queued' in result)) {
    await coordinator.releasePlacement(result.value);
  }
  assert.equal(result.ok && 'queued' in result, true);
  if (result.ok && 'queued' in result) {
    assert.equal(result.diagnostics.queueLane, 'cold_burst');
    assert.equal(
      result.diagnostics.queueReason,
      'resource_budget_insufficient',
    );
    coordinator.beginShutdown();
    await result.waitForPlacement;
    coordinator.finishShutdown();
  }
});

void test('queued cold work promotes after a fresh resource check observes recovered capacity', async () => {
  const identity = {
    threadId: testThreadId(940_51),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  let maxActiveExecutions = 1;
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    placementResourceBudgetProvider: () => ({
      resourceSnapshotRef: {
        snapshotId: `resource-recovery-${maxActiveExecutions}`,
        source: 'agent_resource_budget_provider',
      },
      availableParallelism: { ok: true, value: maxActiveExecutions },
      constrainedMemoryBytes: { ok: true, value: maxActiveExecutions },
      availableMemoryBytes: { ok: true, value: maxActiveExecutions },
    }),
    resourceRequirements: { cpuUnits: 1, memoryBytes: 1 },
  });
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const warm = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_resource_recovery_warm',
    continuity: classifyPtcExecuteCodePlacementContinuity(),
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(warm.ok && !('queued' in warm), true);
  if (!warm.ok || 'queued' in warm) {
    return;
  }

  const queued = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_resource_recovery_queued',
    continuity: classifyPtcExecuteCodePlacementContinuity({
      independenceProof: { reason: 'self_contained' },
    }),
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(queued.ok && 'queued' in queued, true);
  if (!queued.ok || !('queued' in queued)) {
    await coordinator.releasePlacement(warm.value);
    return;
  }

  maxActiveExecutions = 2;
  coordinator.refreshQueuedPlacements?.();
  const promoted = await queued.waitForPlacement;
  assert.equal(promoted.ok, true);
  if (promoted.ok) {
    assert.equal(promoted.value.kind, 'burst');
    assert.equal(
      promoted.value.observation.resourceSnapshotRef?.snapshotId,
      'resource-recovery-2',
    );
    await coordinator.releasePlacement(promoted.value);
  }
  await coordinator.releasePlacement(warm.value);
});

void test('independent read-only overlap cold-creates an isolated burst and cleans it before returning capacity', async () => {
  const identity = {
    threadId: testThreadId(940_6),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const closedIdentities: Array<{ ephemeralBurstId?: string }> = [];
  const { batchRunner } = createUnusedPlacementDependencies();
  const sessionManager = {
    async getOrCreate() {
      throw new Error('not used by placement acquisition');
    },
    async close(closedIdentity) {
      closedIdentities.push(closedIdentity);
      return { ok: true, value: undefined } as const;
    },
    async closeAll() {
      return { ok: true, value: undefined } as const;
    },
  } satisfies PtcSessionDockerManager;
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    ...createResourceAdmission(2),
  });
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 2,
  });
  const warm = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_warm_owner',
    continuity: classifyPtcExecuteCodePlacementContinuity(),
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(warm.ok, true);
  if (!warm.ok || 'queued' in warm) {
    return;
  }
  assert.equal(warm.value.kind, 'warm_session');

  const burst = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_cold_overlap',
    continuity: classifyPtcExecuteCodePlacementContinuity({
      independenceProof: { reason: 'read_only_analysis' },
    }),
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(burst.ok, true);
  if (!burst.ok || 'queued' in burst) {
    return;
  }
  assert.equal(burst.value.kind, 'burst');
  if (burst.value.kind !== 'burst') {
    return;
  }
  assert.equal(burst.value.provisioning, 'coldCreate');
  assert.match(burst.value.identity.ephemeralBurstId, /^ptc_burst_/u);
  assert.equal(burst.value.identity.stateRoot, identity.stateRoot);
  assert.deepEqual(readPtcExecuteCodePlacementObservation(burst.value), {
    executionKind: 'detached_cell',
    cellId: 'ptc_cell_cold_overlap',
    continuity: {
      kind: 'independent',
      reason: 'read_only_analysis',
    },
    callbackEffectPolicy,
    burstEligible: true,
    selectedLane: 'cold_burst',
    reason: 'cold_burst_spillover',
    resourceSnapshotRef: {
      snapshotId: 'resource-capacity-2',
      source: 'agent_resource_budget_provider',
    },
  });

  assert.deepEqual(await coordinator.releasePlacement(burst.value), {
    ok: true,
  });
  assert.deepEqual(closedIdentities, [{ ...burst.value.identity }]);
  await coordinator.releasePlacement(warm.value);
});

void test('child placement is cold-only and refuses unproven or write-capable work', async () => {
  const identity = {
    threadId: testThreadId(940_7),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    ...createResourceAdmission(2),
  });
  const independent = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'map_shard' },
  });
  const readOnly = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 1,
  });
  const child = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_child_cold',
    continuity: independent,
    callbackEffectPolicy: readOnly,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(child.ok, true);
  if (!child.ok || 'queued' in child) {
    return;
  }
  assert.equal(child.value.kind, 'burst');
  assert.equal(child.value.observation.reason, 'child_cold_burst');

  const unproven = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_child_unproven',
    continuity: classifyPtcExecuteCodePlacementContinuity(),
    callbackEffectPolicy: readOnly,
    identity: { ...identity, threadId: testThreadId(940_8) },
    sessionManager,
    batchRunner,
  });
  assert.equal(unproven.ok, false);
  if (!unproven.ok) {
    assert.equal(unproven.reasonCode, 'ptc_lab_session_unavailable');
    assert.equal(unproven.diagnostics.burstEligible, false);
  }

  const writeCapable = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_child_write',
    continuity: independent,
    callbackEffectPolicy: createPtcExecuteCodeCallbackEffectPolicy({
      callbackToolCount: 2,
      writeCallbackToolCount: 1,
    }),
    identity: { ...identity, threadId: testThreadId(940_9) },
    sessionManager,
    batchRunner,
  });
  assert.equal(writeCapable.ok, false);
  if (!writeCapable.ok) {
    assert.equal(writeCapable.diagnostics.burstEligible, false);
  }
  await coordinator.releasePlacement(child.value);
});

void test('write-capable overlap queues for warm continuity instead of spilling cold', async () => {
  const identity = {
    threadId: testThreadId(940_10),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    ...createResourceAdmission(1),
  });
  const readOnly = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const warm = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_write_warm_owner',
    continuity: classifyPtcExecuteCodePlacementContinuity(),
    callbackEffectPolicy: readOnly,
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(warm.ok, true);
  if (!warm.ok || 'queued' in warm) {
    return;
  }
  const queued = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'root_main',
    cellId: 'ptc_cell_write_queued',
    continuity: classifyPtcExecuteCodePlacementContinuity({
      independenceProof: { reason: 'self_contained' },
    }),
    callbackEffectPolicy: createPtcExecuteCodeCallbackEffectPolicy({
      callbackToolCount: 1,
      writeCallbackToolCount: 1,
    }),
    identity,
    sessionManager,
    batchRunner,
  });
  assert.equal(queued.ok, true);
  if (!queued.ok || !('queued' in queued)) {
    return;
  }
  assert.equal(queued.diagnostics.queueLane, 'warm_session');
  await coordinator.releasePlacement(warm.value);
  const promoted = await queued.waitForPlacement;
  assert.equal(promoted.ok, true);
  if (promoted.ok) {
    assert.equal(promoted.value.kind, 'warm_session');
    await coordinator.releasePlacement(promoted.value);
  }
});

void test('burst capacity queues cancellably and advances round-robin across thread FIFOs', async () => {
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const identityA = {
    threadId: testThreadId(940_11),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const identityB = { ...identityA, threadId: testThreadId(940_12) };
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    ...createResourceAdmission(1),
  });
  const continuity = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'map_shard' },
  });
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const acquireChild = (
    identity: typeof identityA,
    cellId: `ptc_cell_${string}`,
    signal?: AbortSignal,
  ) =>
    coordinator.acquirePlacement({
      kind: 'detached_cell',
      ownerKind: 'child',
      cellId,
      continuity,
      callbackEffectPolicy,
      identity,
      sessionManager,
      batchRunner,
      ...(signal === undefined ? {} : { signal }),
    });

  const active = await acquireChild(identityA, 'ptc_cell_fair_active');
  assert.equal(active.ok, true);
  if (!active.ok || 'queued' in active) {
    return;
  }
  const queuedA = await acquireChild(identityA, 'ptc_cell_fair_a');
  const queuedB = await acquireChild(identityB, 'ptc_cell_fair_b');
  const cancelledController = new AbortController();
  const cancelled = await acquireChild(
    identityB,
    'ptc_cell_fair_cancelled',
    cancelledController.signal,
  );
  assert.equal(queuedA.ok && 'queued' in queuedA, true);
  assert.equal(queuedB.ok && 'queued' in queuedB, true);
  assert.equal(cancelled.ok && 'queued' in cancelled, true);
  if (
    !queuedA.ok ||
    !('queued' in queuedA) ||
    !queuedB.ok ||
    !('queued' in queuedB) ||
    !cancelled.ok ||
    !('queued' in cancelled)
  ) {
    return;
  }
  cancelledController.abort();
  const cancelledResult = await cancelled.waitForPlacement;
  assert.equal(cancelledResult.ok, false);
  if (!cancelledResult.ok) {
    assert.equal(cancelledResult.reasonCode, 'ptc_lab_command_cancelled');
  }

  await coordinator.releasePlacement(active.value);
  const promotedA = await queuedA.waitForPlacement;
  assert.equal(promotedA.ok, true);
  if (!promotedA.ok) {
    return;
  }
  assert.equal(promotedA.value.cellId, 'ptc_cell_fair_a');
  await coordinator.releasePlacement(promotedA.value);
  const promotedB = await queuedB.waitForPlacement;
  assert.equal(promotedB.ok, true);
  if (promotedB.ok) {
    assert.equal(promotedB.value.cellId, 'ptc_cell_fair_b');
    await coordinator.releasePlacement(promotedB.value);
  }
});

void test('failed cold cleanup retains burst capacity until cleanup succeeds', async () => {
  const identityA = {
    threadId: testThreadId(940_13),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const identityB = { ...identityA, threadId: testThreadId(940_14) };
  const { batchRunner } = createUnusedPlacementDependencies();
  let closeAttempt = 0;
  const sessionManager = {
    async getOrCreate() {
      throw new Error('not used by placement acquisition');
    },
    async close() {
      closeAttempt += 1;
      return closeAttempt === 1
        ? ({
            ok: false,
            reasonCode: 'container_remove_failed',
            message: 'cleanup still pending',
          } as const)
        : ({ ok: true, value: undefined } as const);
    },
    async closeAll() {
      return { ok: true, value: undefined } as const;
    },
  } satisfies PtcSessionDockerManager;
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    ...createResourceAdmission(1),
  });
  const continuity = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'read_only_analysis' },
  });
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const active = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_cleanup_active',
    continuity,
    callbackEffectPolicy,
    identity: identityA,
    sessionManager,
    batchRunner,
  });
  const queued = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_cleanup_queued',
    continuity,
    callbackEffectPolicy,
    identity: identityB,
    sessionManager,
    batchRunner,
  });
  assert.equal(active.ok && !('queued' in active), true);
  assert.equal(queued.ok && 'queued' in queued, true);
  if (!active.ok || 'queued' in active || !queued.ok || !('queued' in queued)) {
    return;
  }

  const firstRelease = await coordinator.releasePlacement(active.value);
  assert.notEqual(firstRelease, undefined);
  if (firstRelease === undefined) {
    return;
  }
  assert.equal(firstRelease.ok, false);
  let queuedSettled = false;
  void queued.waitForPlacement.then(() => {
    queuedSettled = true;
  });
  await Promise.resolve();
  assert.equal(queuedSettled, false);

  assert.deepEqual(await coordinator.releasePlacement(active.value), {
    ok: true,
  });
  const promoted = await queued.waitForPlacement;
  assert.equal(promoted.ok, true);
  if (promoted.ok) {
    await coordinator.releasePlacement(promoted.value);
  }
});

void test('placement shutdown fences queued burst work without granting a stale lease', async () => {
  const { sessionManager, batchRunner } = createUnusedPlacementDependencies();
  const identityA = {
    threadId: testThreadId(940_15),
    stateRoot: '/workspace',
    trustContextId: 'trust-context',
  };
  const identityB = { ...identityA, threadId: testThreadId(940_16) };
  const coordinator = createPtcExecuteCodePlacementCoordinator({
    burstConfig: { enabled: true },
    ...createResourceAdmission(1),
  });
  const continuity = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'map_shard' },
  });
  const callbackEffectPolicy = createPtcExecuteCodeCallbackEffectPolicy({
    callbackToolCount: 0,
  });
  const active = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_shutdown_active',
    continuity,
    callbackEffectPolicy,
    identity: identityA,
    sessionManager,
    batchRunner,
  });
  const queued = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    ownerKind: 'child',
    cellId: 'ptc_cell_shutdown_queued',
    continuity,
    callbackEffectPolicy,
    identity: identityB,
    sessionManager,
    batchRunner,
  });
  assert.equal(active.ok && !('queued' in active), true);
  assert.equal(queued.ok && 'queued' in queued, true);
  if (!active.ok || 'queued' in active || !queued.ok || !('queued' in queued)) {
    return;
  }

  coordinator.beginShutdown();
  assert.deepEqual(await queued.waitForPlacement, {
    ok: false,
    reasonCode: 'ptc_lab_session_unavailable',
    message: 'PTC placement owner is shutting down',
    diagnostics: {
      placementShutdownState: 'closing',
      shutdownEpoch: 1,
      ownerThreadId: identityB.threadId,
    },
  });
  await coordinator.releasePlacement(active.value);
  coordinator.finishShutdown();
});
