import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  classifyPtcExecuteCodeWarmPlacementDecision,
  createPtcExecuteCodeCallbackEffectPolicy,
  createPtcExecuteCodePlacementPreflightRecord,
  createPtcExecuteCodePlacementCoordinator,
  createPtcExecuteCodePlacementObservation,
  isPtcExecuteCodePlacementBurstEligible,
  readPtcExecuteCodePlacementObservation,
  readPtcExecuteCodePlacementPreflightRecord,
  readPtcExecuteCodePlacementDecision,
  type PtcExecuteCodePlacementBatchRunner,
  type PtcExecuteCodePlacementCoordinator,
} from './execute-code-placement.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';

const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});
const TEST_RUNNING_CELL_REAP_AFTER_MS = 600_000;

function makeTestCellConfig(initialYieldTimeMs: number) {
  return {
    enabled: true,
    initialYieldTimeMs,
    runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
  } as const;
}

function acquireTestWarmPlacement(
  args: Parameters<PtcExecuteCodePlacementCoordinator['acquirePlacement']>[0],
  leaseId: `ptc_warm_lease_${string}`,
) {
  const observation = createPtcExecuteCodePlacementObservation(args);
  return {
    ok: true,
    value: {
      kind: 'warm_session',
      lease: {
        leaseId,
        generation: 1,
        shutdownEpoch: 0,
        ownerThreadId: args.identity.threadId,
      },
      executionKind: args.kind,
      ...(args.kind === 'detached_cell' ? { cellId: args.cellId } : {}),
      continuity: args.continuity,
      observation,
      preflight: createPtcExecuteCodePlacementPreflightRecord(observation),
      identity: args.identity,
      sessionManager: args.sessionManager,
      batchRunner: args.batchRunner,
    },
  } as const;
}

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
  await coordinator.releasePlacement(placement);

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

void test('createPtcExecuteCodeRuntime acquires placement before batch exec and releases it after completion', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-runtime-'),
  );
  const threadId = testThreadId(941);
  const signal = new AbortController().signal;
  const resourceSnapshotRef = {
    snapshotId: 'resource-snapshot-runtime-batch-test',
    source: 'agent_resource_budget_provider',
  } as const;
  const events: string[] = [];
  let observedWorkspaceRoot: string | undefined;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-placement',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        assert.deepEqual(events, [`acquire:${threadId}`]);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'placement ok\n',
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const createPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      acquirePlacement(args) {
        assert.equal(args.signal, signal);
        assert.equal(args.kind, 'batch_command');
        assert.deepEqual(args.continuity, {
          kind: 'defer_to_warm',
          reason: 'unclassified',
        });
        assert.deepEqual(
          args.callbackEffectPolicy,
          createPtcExecuteCodeCallbackEffectPolicy({
            callbackToolCount: 0,
          }),
        );
        assert.deepEqual(args.resourceSnapshotRef, resourceSnapshotRef);
        observedWorkspaceRoot = args.identity.stateRoot;
        events.push(`acquire:${args.identity.threadId}`);
        return acquireTestWarmPlacement(args, 'ptc_warm_lease_runtime_batch');
      },
      releasePlacement(placement) {
        events.push(`release:${placement.identity.threadId}`);
      },
      beginShutdown() {},
      finishShutdown() {},
    });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createPlacementCoordinator,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
      request: { code: 'console.log("placement")' },
      placementResourceSnapshotRef: resourceSnapshotRef,
      signal,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.stdout, 'placement ok\n');
    assert.equal(Object.hasOwn(result.value, 'placement'), false);
    assert.equal(Object.hasOwn(result.value, 'preflight'), false);
    assert.equal(Object.hasOwn(result.value, 'warmDecision'), false);
    assert.equal(Object.hasOwn(result.value, 'selectedLane'), false);
    assert.deepEqual(events, [`acquire:${threadId}`, `release:${threadId}`]);
    assert.equal(observedWorkspaceRoot, await realpath(stateRoot));
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime returns placement conflict before starting batch execution', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-busy-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-busy-runtime-'),
  );
  const threadId = testThreadId(941_2);
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-placement-busy',
  });
  const createPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      acquirePlacement() {
        return {
          ok: false,
          reasonCode: 'ptc_lab_session_busy',
          message: 'PTC warm session already has an active placement lease',
          remediation:
            'Wait for the active exec cell to settle before retrying.',
          diagnostics: {
            placementLane: 'warm_session',
            activeExecutionKind: 'detached_cell',
          },
        };
      },
      releasePlacement() {
        assert.fail('failed placement acquisition must not release a lease');
      },
      beginShutdown() {},
      finishShutdown() {},
    });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createPlacementCoordinator,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
      request: { code: 'console.log("must not run")' },
    });

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'ptc_lab_session_busy',
      message: 'PTC warm session already has an active placement lease',
      remediation: 'Wait for the active exec cell to settle before retrying.',
      diagnostics: {
        placementLane: 'warm_session',
        activeExecutionKind: 'detached_cell',
      },
    });
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      0,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime releases placement after callback bridge setup failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-bridge-fail-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-bridge-fail-runtime-'),
  );
  const threadId = testThreadId(941_1);
  const events: string[] = [];
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-placement-bridge-fail',
  });
  const createPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      acquirePlacement(args) {
        assert.equal(args.kind, 'batch_command');
        assert.deepEqual(args.continuity, {
          kind: 'defer_to_warm',
          reason: 'unclassified',
        });
        assert.deepEqual(
          args.callbackEffectPolicy,
          createPtcExecuteCodeCallbackEffectPolicy({
            callbackToolCount: 0,
          }),
        );
        events.push(`acquire:${args.identity.threadId}`);
        return acquireTestWarmPlacement(
          args,
          'ptc_warm_lease_runtime_bridge_failure',
        );
      },
      releasePlacement(placement) {
        events.push(`release:${placement.identity.threadId}`);
      },
      beginShutdown() {},
      finishShutdown() {},
    });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async () => ({
      ok: false,
      reasonCode: 'callback_channel_failed',
      message: 'callback channel failed in placement release test',
      diagnostics: { callbackTransportPolicyRequired: true },
    }),
    createPlacementCoordinator,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
      request: { code: 'console.log("bridge failure")' },
      toolCallbackHandler: async () => ({
        ok: true,
        result: { ok: true, output: '' },
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(
      result.reasonCode,
      'ptc_execute_code_callback_bridge_unavailable',
    );
    assert.deepEqual(result.diagnostics, {
      callbackTransportPolicyRequired: true,
      bridgeReasonCode: 'callback_channel_failed',
    });
    assert.deepEqual(events, [`acquire:${threadId}`, `release:${threadId}`]);
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      0,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime releases placement after detached cell startup failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-cell-fail-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-cell-fail-runtime-'),
  );
  const threadId = testThreadId(942);
  const events: string[] = [];
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-placement-cell-fail',
  });
  const createPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      acquirePlacement(args) {
        assert.equal(args.kind, 'detached_cell');
        assert.deepEqual(args.continuity, {
          kind: 'defer_to_warm',
          reason: 'unclassified',
        });
        events.push(`acquire:${args.identity.threadId}`);
        return acquireTestWarmPlacement(
          args,
          'ptc_warm_lease_runtime_cell_failure',
        );
      },
      releasePlacement(placement) {
        events.push(`release:${placement.identity.threadId}`);
      },
      beginShutdown() {},
      finishShutdown() {},
    });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createPlacementCoordinator,
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForState: () => runtimeRoot,
    startCellProcess: () => {
      assert.deepEqual(events, [`acquire:${threadId}`]);
      return {
        ok: false,
        reasonCode: 'spawn_failed',
        message: 'spawn failed for placement release test',
      };
    },
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reasonCode, 'ptc_lab_command_failed');
    assert.deepEqual(result.diagnostics, { spawnFailed: true });
    assert.deepEqual(events, [`acquire:${threadId}`, `release:${threadId}`]);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
