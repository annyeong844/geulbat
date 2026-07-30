import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestPtcExecuteCodeCellConfig as makeTestCellConfig } from '../../../../test-support/ptc-execute-code-runtime-cell.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import {
  createPtcExecuteCodeCallbackEffectPolicy,
  createPtcExecuteCodePlacementPreflightRecord,
  createPtcExecuteCodePlacementObservation,
  type PtcExecuteCodePlacementCoordinator,
} from './execute-code-placement-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';

const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

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
