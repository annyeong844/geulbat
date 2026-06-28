import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testProjectId } from '../../../../test-support/project-id.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunWorkspaceContext } from '../../../../test-support/run-workspace-context.js';
import {
  classifyPtcExecuteCodePlacementContinuity,
  classifyPtcExecuteCodeWarmPlacementDecision,
  createPtcExecuteCodeReadOnlyCallbackEffectPolicy,
  createPtcExecuteCodeWarmOnlyPlacementPreflightRecord,
  createPtcExecuteCodeWarmSessionPlacementCoordinator,
  createPtcExecuteCodeWarmSessionPlacementObservation,
  isPtcExecuteCodePlacementBurstEligible,
  readPtcExecuteCodePlacementObservation,
  readPtcExecuteCodePlacementPreflightRecord,
  readPtcExecuteCodePlacementWarmDecision,
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

void test('createPtcExecuteCodeWarmSessionPlacementCoordinator keeps warm session dependencies unchanged', async () => {
  const identity = {
    threadId: testThreadId(940),
    workspaceRoot: '/workspace',
    trustContextId: 'trust-context',
  };
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
  const signal = new AbortController().signal;
  const continuity = classifyPtcExecuteCodePlacementContinuity();
  const callbackEffectPolicy = createPtcExecuteCodeReadOnlyCallbackEffectPolicy(
    { callbackToolCount: 2 },
  );

  const coordinator = createPtcExecuteCodeWarmSessionPlacementCoordinator();
  const placement = await coordinator.acquirePlacement({
    kind: 'batch_command',
    continuity,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
    signal,
  });

  assert.equal(placement.kind, 'warm_session');
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
  });
  const batchWarmDecision =
    readPtcExecuteCodePlacementWarmDecision(batchObservation);
  assert.deepEqual(readPtcExecuteCodePlacementPreflightRecord(placement), {
    input: batchObservation,
    warmDecision: batchWarmDecision,
    burstEligible: false,
    selectedLane: 'warm_session',
    reason: 'independence_not_proven',
  });
  assert.equal('cellId' in placement, false);
  assert.equal(placement.identity, identity);
  assert.equal(placement.sessionManager, sessionManager);
  assert.equal(placement.batchRunner, batchRunner);
  await coordinator.releasePlacement(placement);

  const independent = classifyPtcExecuteCodePlacementContinuity({
    independenceProof: { reason: 'self_contained' },
  });
  const cellPlacement = await coordinator.acquirePlacement({
    kind: 'detached_cell',
    cellId: 'ptc_cell_placement_observation',
    continuity: independent,
    callbackEffectPolicy,
    identity,
    sessionManager,
    batchRunner,
    signal,
  });

  assert.equal(cellPlacement.kind, 'warm_session');
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
  const cellWarmDecision =
    readPtcExecuteCodePlacementWarmDecision(cellObservation);
  assert.deepEqual(readPtcExecuteCodePlacementPreflightRecord(cellPlacement), {
    input: cellObservation,
    warmDecision: cellWarmDecision,
    burstEligible: true,
    selectedLane: 'warm_session',
    reason: 'burst_not_enabled_yet',
  });
  await coordinator.releasePlacement(cellPlacement);
});

void test('createPtcExecuteCodeRuntime acquires placement before batch exec and releases it after completion', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-placement-runtime-'),
  );
  const threadId = testThreadId(941);
  const signal = new AbortController().signal;
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
          createPtcExecuteCodeReadOnlyCallbackEffectPolicy({
            callbackToolCount: 0,
          }),
        );
        observedWorkspaceRoot = args.identity.workspaceRoot;
        events.push(`acquire:${args.identity.threadId}`);
        const observation =
          createPtcExecuteCodeWarmSessionPlacementObservation(args);
        return {
          kind: 'warm_session',
          executionKind: args.kind,
          continuity: args.continuity,
          observation,
          preflight:
            createPtcExecuteCodeWarmOnlyPlacementPreflightRecord(observation),
          identity: args.identity,
          sessionManager: args.sessionManager,
          batchRunner: args.batchRunner,
        };
      },
      releasePlacement(placement) {
        events.push(`release:${placement.identity.threadId}`);
      },
    });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createPlacementCoordinator,
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId,
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'console.log("placement")' },
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
    assert.equal(observedWorkspaceRoot, await realpath(workspaceRoot));
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
