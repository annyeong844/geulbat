import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  deferredDetachedProcessExit as deferredExit,
  makeDetachedHandle,
  makeDetachedSegment,
} from '../../../../test-support/ptc-execute-code-cell-process.js';
import { makeTestPtcExecuteCodeCellConfig as makeTestCellConfig } from '../../../../test-support/ptc-execute-code-runtime-cell.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { createPtcExecuteCodePlacementCoordinator } from './execute-code-placement.js';
import {
  createPtcExecuteCodeCallbackEffectPolicy,
  type PtcExecuteCodePlacementCoordinator,
} from './execute-code-placement-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';

void test('createPtcExecuteCodeRuntime releases admitting cell after placement conflict', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-placement-busy-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-placement-busy-runtime-'),
  );
  const threadId = testThreadId(913_1);
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_placement_busy',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-placement-busy',
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
            activeExecutionKind: 'batch_command',
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
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    createPlacementCoordinator,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
    startCellProcess: () => {
      assert.fail('placement conflict must stop before process start');
    },
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
        activeExecutionKind: 'batch_command',
      },
    });
    assert.equal(registry.readCellState({ threadId }), null);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keeps cell placement until a yielded cell settles', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-placement-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-placement-runtime-'),
  );
  const threadId = testThreadId(913_2);
  const resourceSnapshotRef = {
    snapshotId: 'resource-snapshot-runtime-cell-test',
    source: 'agent_resource_budget_provider',
  } as const;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_placement',
  });
  const events: string[] = [];
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-placement',
  });
  const exit = deferredExit();
  const placementOwner = createPtcExecuteCodePlacementCoordinator();
  const createPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      async acquirePlacement(args) {
        assert.equal(args.kind, 'detached_cell');
        assert.equal(args.cellId, 'ptc_cell_runtime_placement');
        assert.deepEqual(args.continuity, {
          kind: 'independent',
          reason: 'self_contained',
        });
        assert.deepEqual(
          args.callbackEffectPolicy,
          createPtcExecuteCodeCallbackEffectPolicy({
            callbackToolCount: 0,
          }),
        );
        assert.deepEqual(args.resourceSnapshotRef, resourceSnapshotRef);
        events.push(`acquire:${args.identity.threadId}`);
        return await placementOwner.acquirePlacement(args);
      },
      async releasePlacement(placement) {
        await placementOwner.releasePlacement(placement);
        events.push(`release:${placement.identity.threadId}`);
      },
      beginShutdown() {
        placementOwner.beginShutdown();
      },
      finishShutdown() {
        placementOwner.finishShutdown();
      },
    });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    createPlacementCoordinator,
    getPlacementContinuityProvenance(args) {
      assert.equal(args.kind, 'detached_cell');
      assert.equal(args.cellId, 'ptc_cell_runtime_placement');
      assert.equal(args.identity.threadId, threadId);
      assert.equal(args.request.code, 'await new Promise(() => {})');
      assert.equal(args.request.timeoutMs, 60_000);
      return { independenceProof: { reason: 'self_contained' } };
    },
    startCellProcess: () => {
      assert.deepEqual(events, [`acquire:${threadId}`]);
      return {
        ok: true,
        handle: makeDetachedHandle({
          output: makeDetachedSegment({ stdout: 'partial\n' }),
          exit: exit.promise,
        }),
      };
    },
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
      placementResourceSnapshotRef: resourceSnapshotRef,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    assert.equal(result.value.status, 'running');
    assert.equal(Object.hasOwn(result.value, 'placement'), false);
    assert.equal(Object.hasOwn(result.value, 'preflight'), false);
    assert.equal(Object.hasOwn(result.value, 'warmDecision'), false);
    assert.equal(Object.hasOwn(result.value, 'selectedLane'), false);
    assert.deepEqual(events, [`acquire:${threadId}`]);

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    const completedWait = await runtime.waitForCell({
      runContext: { threadId },
      request: { cellId: 'ptc_cell_runtime_placement' },
    });
    assert.equal(completedWait.ok, true);
    if (!completedWait.ok) {
      return;
    }
    assert.equal(Object.hasOwn(completedWait.value, 'placement'), false);
    assert.equal(Object.hasOwn(completedWait.value, 'preflight'), false);
    assert.equal(Object.hasOwn(completedWait.value, 'warmDecision'), false);
    assert.equal(Object.hasOwn(completedWait.value, 'selectedLane'), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [`acquire:${threadId}`, `release:${threadId}`]);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes yielded cells when the owner signal aborts', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-owner-abort-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-owner-abort-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_owner_abort',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-owner-abort',
  });
  const exit = deferredExit();
  const controller = new AbortController();
  let terminateCount = 0;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () => makeDetachedSegment({ stdout: 'partial\n' }),
        exit: exit.promise,
        terminate: () => {
          terminateCount += 1;
          exit.resolve({
            kind: 'signal',
            exitCode: null,
            processTerminated: false,
          });
        },
      },
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(950),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
      signal: controller.signal,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    if (result.value.executionSurface !== 'node_via_lab_detached_cell') {
      return;
    }
    assert.equal(result.value.status, 'running');

    controller.abort();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (registry.readCellState({ threadId: testThreadId(950) }) === null) {
        break;
      }
      await delay(10);
    }

    assert.equal(terminateCount, 1);
    assert.equal(registry.readCellState({ threadId: testThreadId(950) }), null);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-owner-abort']],
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
