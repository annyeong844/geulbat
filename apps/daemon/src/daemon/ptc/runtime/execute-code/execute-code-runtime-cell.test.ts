import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testProjectId } from '../../../../test-support/project-id.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunWorkspaceContext } from '../../../../test-support/run-workspace-context.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import {
  createPtcExecuteCodeReadOnlyCallbackEffectPolicy,
  createPtcExecuteCodeWarmOnlyPlacementPreflightRecord,
  createPtcExecuteCodeWarmSessionPlacementObservation,
  type PtcExecuteCodePlacementCoordinator,
} from './execute-code-placement.js';
import { waitForExecuteCodeCell } from './execute-code-cell-wait.js';
import { PTC_EXECUTE_CODE_TOOL_NAME } from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM } from '../../lab/profile/lab-profile-contract.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
  PtcDockerClientProcessInvocation,
} from '../../shared/process-command.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/ptc/private-token';
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

void test('createPtcExecuteCodeRuntime leaves the cell registry dormant when ptcCell is disabled', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-disabled-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-disabled-runtime-'),
  );
  let cellRegistryCreated = false;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-disabled',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'cell disabled uses batch path\n',
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => {
      cellRegistryCreated = true;
      throw new Error('cell registry must stay dormant');
    },
    ptcCell: { enabled: false },
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(910),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'console.log("cell disabled")' },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.stdout, 'cell disabled uses batch path\n');
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    assert.equal(cellRegistryCreated, false);
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      1,
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports cell wait unavailable while ptcCell is disabled', async () => {
  const runtime = createPtcExecuteCodeRuntime({
    createCellRegistry: () => {
      throw new Error('disabled cell wait must not create the registry');
    },
    ptcCell: { enabled: false },
  });

  assert.deepEqual(
    await runtime.waitForCell({
      runContext: { threadId: testThreadId(910) },
      request: { cellId: 'ptc_cell_disabled' },
    }),
    {
      ok: false,
      reasonCode: 'ptc_execute_code_cell_wait_unavailable',
      message: 'PTC execute_code cell wait is not enabled',
    },
  );
});

void test('createPtcExecuteCodeRuntime can complete through the enabled detached cell branch', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-complete-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-complete-runtime-'),
  );
  const cellStarts: PtcDockerClientProcessInvocation[] = [];
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-complete',
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: (invocation) => {
      cellStarts.push(invocation);
      return {
        ok: true,
        handle: makeDetachedHandle({
          output: makeDetachedSegment({ stdout: 'cell completed\n' }),
        }),
      };
    },
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(911),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      invocationId: 'call-ptc-cell-complete',
      request: { code: 'console.log("cell enabled")' },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    assert.equal(result.value.stdout, 'cell completed\n');
    assert.equal(result.value.sessionLifecycle.retainedAfterExecution, true);
    assert.equal(cellStarts.length, 1);
    assert.deepEqual(cellStarts[0]?.args.slice(0, 4), [
      'exec',
      'container-agent-ptc-execute-code-cell-complete',
      '/bin/bash',
      '-lc',
    ]);
    assert.deepEqual(cellStarts[0]?.outputBufferPolicy, {
      maxBufferedBytesPerStream:
        PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
    });
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      0,
    );
    const retriedResult = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(911),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      invocationId: 'call-ptc-cell-complete',
      request: { code: 'console.log("cell enabled")' },
    });
    assert.equal(retriedResult.ok, true);
    if (!retriedResult.ok) {
      return;
    }
    assert.equal(retriedResult.value.stdout, 'cell completed\n');
    assert.equal(cellStarts.length, 2);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime tags cell callback invocations with the reserved cell id', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-callback-source-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-callback-source-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-callback-source',
  });
  let observedCellId: string | undefined;
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async (bridgeArgs) => {
      const callbackResult = await bridgeArgs.callbackHandler({
        requestId: 'runtime-callback-read-1',
        kind: 'geulbat_tool_call',
        args: { toolName: 'read_file', args: { path: 'note.txt' } },
        signal: new AbortController().signal,
        enterLongWait: () => true,
      });
      assert.equal(callbackResult.ok, true);
      const session = await bridgeArgs.sessionManager.getOrCreate(
        bridgeArgs.identity,
      );
      assert.equal(session.ok, true);
      if (!session.ok) {
        throw new Error('expected session');
      }
      return {
        ok: true,
        value: {
          containerId: session.value.containerId,
          epochId: 'epoch-cell-callback-source',
          token: 'token-cell-callback-source',
          callbackSocketHostPath: join(
            session.value.callbackRootHostPath,
            'callback.sock',
          ),
          callbackSocketContainerPath: '/geulbat/callbacks/callback.sock',
          session: session.value,
          close: async () => {},
        },
      };
    },
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'cell completed\n' }),
      }),
    }),
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(911_1),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'console.log("cell callback")' },
      toolCallbackHandler: async (invocation) => {
        observedCellId = invocation.cellId;
        return { ok: true, result: { ok: true, output: 'callback ok' } };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(observedCellId?.startsWith('ptc_cell_'), true);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime removes the initial abort listener after fast cell exit', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-exit-listener-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-exit-listener-runtime-'),
  );
  const controller = new AbortController();
  const abortListeners = trackAbortListeners(controller.signal);
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-exit-listener',
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'cell completed\n' }),
      }),
    }),
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(912_1),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'console.log("cell exits quickly")' },
      signal: controller.signal,
    });

    assert.equal(result.ok, true);
    assert.equal(abortListeners.listenerCount(), 0);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keeps only the owner abort listener after initial yield', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-listener-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-listener-runtime-'),
  );
  const controller = new AbortController();
  const abortListeners = trackAbortListeners(controller.signal);
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-yield-listener',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () => makeDetachedSegment({ stdout: 'partial\n' }),
        exit: exit.promise,
        terminate: () => {
          exit.resolve({
            kind: 'signal',
            exitCode: null,
            processTerminated: false,
          });
        },
      },
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(912_2),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    assert.equal(abortListeners.listenerCount(), 1);

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abortListeners.listenerCount(), 0);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime returns a running cell summary when the enabled detached branch yields first', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-running-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-running-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_running',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-running',
  });
  const exit = deferredExit();
  let cellStartCount = 0;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => {
      cellStartCount += 1;
      return {
        ok: true,
        handle: makeDetachedHandle({
          output: makeDetachedSegment({ stdout: 'partial\n' }),
          exit: exit.promise,
        }),
      };
    },
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(913),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      invocationId: 'call-ptc-cell-running',
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    assert.equal(result.value.status, 'running');
    assert.equal(result.value.cellId, 'ptc_cell_runtime_running');
    assert.equal(result.value.stdout, 'partial\n');
    const retriedRunResult = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(913),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      invocationId: 'call-ptc-cell-running',
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
    });
    assert.deepEqual(retriedRunResult, result);
    assert.equal(cellStartCount, 1);
    assert.deepEqual(registry.readCellState({ threadId: testThreadId(913) }), {
      cellId: 'ptc_cell_runtime_running',
      state: 'running',
    });
    const otherThreadWait = await runtime.waitForCell({
      runContext: { threadId: 'other-thread' },
      request: { cellId: 'ptc_cell_runtime_running' },
    });
    assert.deepEqual(otherThreadWait, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'missing',
        cellId: 'ptc_cell_runtime_running',
        remediation: 'start_a_new_exec',
      },
    });
    const retriedAfterForeignWait = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(913),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      invocationId: 'call-ptc-cell-running',
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
    });
    assert.deepEqual(retriedAfterForeignWait, result);
    assert.equal(cellStartCount, 1);

    const runningWait = await runtime.waitForCell({
      runContext: { threadId: testThreadId(913) },
      request: { cellId: 'ptc_cell_runtime_running', yieldTimeMs: 1_000 },
    });
    assert.deepEqual(runningWait, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'running',
        cellId: 'ptc_cell_runtime_running',
        stdout: 'partial\n',
        stderr: '',
      },
    });

    const overCeilingWait = await runtime.waitForCell({
      runContext: { threadId: testThreadId(913) },
      request: { cellId: 'ptc_cell_runtime_running', yieldTimeMs: 120_000 },
    });
    assert.equal(overCeilingWait.ok, false);
    assert.equal(
      overCeilingWait.ok ? '' : overCeilingWait.reasonCode,
      'ptc_execute_code_invalid',
    );
    assert.match(
      overCeilingWait.ok ? '' : overCeilingWait.message,
      /exceeds the cell execution timeout/u,
    );

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(registry.readCellState({ threadId: testThreadId(913) }), {
      cellId: 'ptc_cell_runtime_running',
      state: 'terminal_retained',
    });
    const retriedAfterSettle = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(913),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      invocationId: 'call-ptc-cell-running',
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
    });
    assert.equal(retriedAfterSettle.ok, false);
    assert.equal(
      retriedAfterSettle.ok ? '' : retriedAfterSettle.reasonCode,
      'ptc_execute_code_cell_result_unclaimed',
    );
    const unclaimedConflict = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(913),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'return 2' },
    });
    assert.equal(unclaimedConflict.ok, false);
    assert.equal(
      unclaimedConflict.ok ? '' : unclaimedConflict.reasonCode,
      'ptc_execute_code_cell_result_unclaimed',
    );
    assert.deepEqual(
      unclaimedConflict.ok ? undefined : unclaimedConflict.diagnostics,
      {
        cellId: 'ptc_cell_runtime_running',
        cellState: 'terminal_retained',
      },
    );
    const completedWait = await runtime.waitForCell({
      runContext: { threadId: testThreadId(913) },
      request: { cellId: 'ptc_cell_runtime_running', terminate: true },
    });
    assert.deepEqual(completedWait, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'completed',
        cellId: 'ptc_cell_runtime_running',
        exitCode: 0,
        stdout: 'partial\n',
        stderr: '',
      },
    });
    const retriedCompletedWait = await runtime.waitForCell({
      runContext: { threadId: testThreadId(913) },
      request: { cellId: 'ptc_cell_runtime_running' },
    });
    assert.deepEqual(retriedCompletedWait, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'missing',
        cellId: 'ptc_cell_runtime_running',
        remediation: 'start_a_new_exec',
      },
    });
    assert.equal(registry.readCellState({ threadId: testThreadId(913) }), null);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keeps cell placement until a yielded cell settles', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-placement-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-placement-runtime-'),
  );
  const threadId = testThreadId(913_1);
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
  const createPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      acquirePlacement(args) {
        assert.equal(args.kind, 'detached_cell');
        assert.equal(args.cellId, 'ptc_cell_runtime_placement');
        assert.deepEqual(args.continuity, {
          kind: 'independent',
          reason: 'self_contained',
        });
        assert.deepEqual(
          args.callbackEffectPolicy,
          createPtcExecuteCodeReadOnlyCallbackEffectPolicy({
            callbackToolCount: 0,
          }),
        );
        assert.deepEqual(args.resourceSnapshotRef, resourceSnapshotRef);
        events.push(`acquire:${args.identity.threadId}`);
        const observation =
          createPtcExecuteCodeWarmSessionPlacementObservation(args);
        return {
          kind: 'warm_session',
          executionKind: args.kind,
          cellId: args.cellId,
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId,
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes yielded cells when the owner signal aborts', async () => {
  const workspaceRoot = await mkdtemp(
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(950),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell without a yield window wakes when a running cell completes', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-wait-wake-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-wait-wake-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_wait_wake',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-wait-wake',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({
      ok: true,
      handle: makeExitGatedDetachedHandle({
        output: makeDetachedSegment({ stdout: 'finished during wait\n' }),
        exit: exit.promise,
      }),
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(938),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');

    const wait = runtime.waitForCell({
      runContext: { threadId: testThreadId(938) },
      request: { cellId: 'ptc_cell_runtime_wait_wake' },
    });
    queueMicrotask(() =>
      exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true }),
    );

    const completed = await Promise.race([
      wait,
      delay(250).then(() => {
        throw new Error('cell wait did not wake on completion');
      }),
    ]);

    assert.deepEqual(completed, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'completed',
        cellId: 'ptc_cell_runtime_wait_wake',
        exitCode: 0,
        stdout: 'finished during wait\n',
        stderr: '',
      },
    });
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell without a yield window wakes on new running output', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-output-wake-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-output-wake-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_output_wake',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-output-wake',
  });
  const exit = deferredExit();
  const handle = makeObservableDetachedHandle({ exit: exit.promise });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({ ok: true, handle }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(938_1),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');

    const wait = runtime.waitForCell({
      runContext: { threadId: testThreadId(938_1) },
      request: { cellId: 'ptc_cell_runtime_output_wake' },
    });
    queueMicrotask(() => {
      handle.appendOutput(makeDetachedSegment({ stdout: 'new output\n' }));
    });

    const observed = await Promise.race([
      wait,
      delay(250).then(() => {
        throw new Error('cell wait did not wake on new output');
      }),
    ]);

    assert.deepEqual(observed, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'running',
        cellId: 'ptc_cell_runtime_output_wake',
        stdout: 'new output\n',
        stderr: '',
      },
    });

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell reports yielded cell output policy rejection', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-output-limit-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-output-limit-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_output_limit',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-output-limit',
  });
  const exit = deferredExit();
  const handle = makeExitGatedDetachedHandle({
    output: makeDetachedSegment({ stdout: 'safe-before-limit' }),
    exit: exit.promise,
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({ ok: true, handle }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(938_4),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'process.stdout.write("x".repeat(99_999_999))' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');

    const wait = runtime.waitForCell({
      runContext: { threadId: testThreadId(938_4) },
      request: { cellId: 'ptc_cell_runtime_output_limit' },
    });
    exit.resolve({
      kind: 'output_limit_exceeded',
      exitCode: null,
      processTerminated: false,
      stream: 'stdout',
      maxBufferedBytesPerStream: 1024,
    });

    const observed = await wait;
    assert.equal(observed.ok, false);
    assert.equal(
      observed.ok ? '' : observed.reasonCode,
      'ptc_lab_command_output_rejected',
    );
    assert.equal(
      observed.ok ? '' : observed.diagnostics?.outputStream,
      'stdout',
    );
    assert.equal(
      observed.ok ? 0 : observed.diagnostics?.maxBufferedBytesPerStream,
      1024,
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell reports yielded cell timeout', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-wait-timeout-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-wait-timeout-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_wait_timeout',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-wait-timeout',
  });
  const exit = deferredExit();
  const handle = makeExitGatedDetachedHandle({
    output: makeDetachedSegment({ stdout: 'before timeout\n' }),
    exit: exit.promise,
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({ ok: true, handle }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(938_5),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 1_000 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');

    const wait = runtime.waitForCell({
      runContext: { threadId: testThreadId(938_5) },
      request: { cellId: 'ptc_cell_runtime_wait_timeout' },
    });
    exit.resolve({
      kind: 'timeout',
      exitCode: null,
      processTerminated: false,
    });

    const observed = await wait;
    assert.equal(observed.ok, false);
    assert.equal(
      observed.ok ? '' : observed.reasonCode,
      'ptc_lab_command_timeout',
    );
    assert.equal(
      observed.ok ? '' : observed.diagnostics?.cellExitKind,
      'timeout',
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell ignores unrelated thread revisions', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-thread-wake-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-thread-wake-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: (() => {
      let nextCellId = 0;
      return () => `ptc_cell_runtime_thread_wake_${(nextCellId += 1)}`;
    })(),
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-thread-wake',
  });
  const exit = deferredExit();
  const handle = makeObservableDetachedHandle({ exit: exit.promise });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({ ok: true, handle }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });
  const ownerThreadId = testThreadId(938_2);
  const unrelatedThreadId = testThreadId(938_3);

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: ownerThreadId,
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    if (result.value.executionSurface !== 'node_via_lab_detached_cell') {
      return;
    }

    let settled = false;
    const wait = runtime
      .waitForCell({
        runContext: { threadId: ownerThreadId },
        request: { cellId: result.value.cellId },
      })
      .finally(() => {
        settled = true;
      });

    await delay(0);
    const unrelatedAdmission = registry.reserveAdmittingCell({
      threadId: unrelatedThreadId,
    });
    assert.equal(unrelatedAdmission.ok, true);
    if (unrelatedAdmission.ok) {
      registry.releaseAdmittingCell({
        threadId: unrelatedThreadId,
        cellId: unrelatedAdmission.cellId,
      });
    }
    await delay(20);
    assert.equal(settled, false);

    handle.appendOutput(makeDetachedSegment({ stdout: 'owner output\n' }));
    const observed = await Promise.race([
      wait,
      delay(250).then(() => {
        throw new Error('cell wait did not wake on owner output');
      }),
    ]);

    assert.deepEqual(observed, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'running',
        cellId: result.value.cellId,
        stdout: 'owner output\n',
        stderr: '',
      },
    });

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime caps initial cell yield by request timeout', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-cap-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-cap-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-yield-cap',
  });
  const exit = deferredExit();
  const cellStarts: PtcDockerClientProcessInvocation[] = [];
  let terminated = false;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: (invocation) => {
      cellStarts.push(invocation);
      return {
        ok: true,
        handle: {
          drainNewOutput: () =>
            makeDetachedSegment({ stdout: 'still running\n' }),
          exit: exit.promise,
          terminate: () => {
            terminated = true;
            exit.resolve({
              kind: 'signal',
              exitCode: null,
              processTerminated: false,
            });
          },
        },
      };
    },
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await Promise.race([
      runtime.executeCode({
        runContext: makeRunWorkspaceContext({
          threadId: testThreadId(931),
          projectId: testProjectId('project'),
          workspaceRoot,
        }),
        request: { code: 'await new Promise(() => {})', timeoutMs: 1 },
      }),
      delay(250).then(() => {
        throw new Error('cell yield was not capped by request timeout');
      }),
    ]);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    assert.equal(result.value.status, 'running');
    assert.equal(result.value.effectiveTimeoutMs, 1);
    assert.equal(cellStarts[0]?.timeoutMs, 1);
  } finally {
    await runtime.closeAll();
    assert.equal(terminated, true);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports an initial detached cell timeout', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-timeout-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-timeout-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-timeout',
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'still running\n' }),
        exit: Promise.resolve({
          kind: 'timeout',
          exitCode: null,
          processTerminated: false,
        }),
      }),
    }),
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(931_2),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 1_000 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
    assert.equal(result.ok ? '' : result.diagnostics?.cellExitKind, 'timeout');
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime rejects explicit cell yield beyond the execution timeout', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-invalid-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-invalid-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-yield-invalid',
  });
  let cellStarted = false;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => {
      cellStarted = true;
      return {
        ok: true,
        handle: makeDetachedHandle({ output: makeDetachedSegment() }),
      };
    },
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(931_1),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: {
        code: 'await new Promise(() => {})',
        timeoutMs: 1_000,
        yieldTimeMs: 2_000,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_execute_code_invalid',
    );
    assert.match(
      result.ok ? '' : result.message,
      /exceeds the execution timeout/u,
    );
    assert.equal(cellStarted, false);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime aborts the initial cell wait and taints the session', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-abort-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-abort-runtime-'),
  );
  const controller = new AbortController();
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-abort',
  });
  const exit = deferredExit();
  let terminateCount = 0;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => {
      queueMicrotask(() => controller.abort());
      return {
        ok: true,
        handle: {
          drainNewOutput: () => makeDetachedSegment({ stdout: 'aborted\n' }),
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
      };
    },
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(932),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 60_000 },
      signal: controller.signal,
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_command_cancelled',
    );
    assert.equal(terminateCount, 1);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-abort']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes callback-created sessions after cell bridge setup fails', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-bridge-setup-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-bridge-setup-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-bridge-setup',
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async (bridgeArgs) => {
      const session = await bridgeArgs.sessionManager.getOrCreate(
        bridgeArgs.identity,
      );
      assert.equal(session.ok, true);
      return {
        ok: false,
        reasonCode: 'callback_channel_failed',
        message: 'callback channel failed in test',
        diagnostics: { sessionReasonCode: 'docker_unavailable' },
      };
    },
    startCellProcess: () => {
      throw new Error('cell process must not start after bridge setup failure');
    },
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(933),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'return 1' },
      toolCallbackHandler: async () => ({
        ok: true,
        result: { ok: true, output: '' },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_execute_code_callback_bridge_unavailable',
    );
    assert.deepEqual(result.ok ? undefined : result.diagnostics, {
      sessionReasonCode: 'docker_unavailable',
      bridgeReasonCode: 'callback_channel_failed',
    });
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-bridge-setup']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime taint-closes the session when cell promotion is lost', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-promotion-lost-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-promotion-lost-runtime-'),
  );
  const baseRegistry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_promotion_lost',
  });
  const registry: ReturnType<typeof createPtcExecuteCodeCellRegistry> = {
    ...baseRegistry,
    promoteAdmittedCell: () => ({ ok: false, reasonCode: 'cell_missing' }),
  };
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-promotion-lost',
  });
  const exit = deferredExit();
  let terminateCount = 0;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () => makeDetachedSegment({ stdout: 'lost\n' }),
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
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(933_1),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_execute_code_invalid',
    );
    assert.equal(terminateCount, 1);
    assert.equal(
      baseRegistry.readCellState({ threadId: testThreadId(933_1) }),
      null,
    );
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-promotion-lost']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime sanitizes detached cell output before returning it', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-redaction-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-redaction-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-redaction',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () =>
          makeDetachedSegment({
            stdout: `path=${PRIVATE_TEST_PATH} NPM_TOKEN=secret\n`,
            stderr: `/geulbat/callbacks/callback.sock token=secret\n`,
          }),
        exit: exit.promise,
        terminate: () => {
          exit.resolve({
            kind: 'signal',
            exitCode: null,
            processTerminated: false,
          });
        },
      },
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(934),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    assert.doesNotMatch(
      `${result.value.stdout}\n${result.value.stderr}`,
      /geulbat-private|\.geulbat|private-token|NPM_TOKEN=secret|callback\.sock|token=secret/u,
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('waitForExecuteCodeCell preserves terminal output when terminate races natural completion', async () => {
  const threadId = testThreadId(914);
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_wait_terminate_race',
  });
  const admitted = registry.reserveAdmittingCell({ threadId });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }

  registry.promoteAdmittedCell({
    threadId,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'unused-active-output\n' }),
      }),
      closeBridge: () => {},
      taintSession: () => {
        throw new Error('natural completion must not taint the session');
      },
    },
  });

  const terminalResult = {
    status: 'completed' as const,
    output: makeDetachedSegment({ stdout: 'IMPORTANT RESULT\n' }),
    exit: { kind: 'exit', exitCode: 0, processTerminated: true } as const,
  };
  let closeCalls = 0;
  const racingRegistry: ReturnType<typeof createPtcExecuteCodeCellRegistry> = {
    ...registry,
    closeCell: async (args) => {
      closeCalls += 1;
      const recorded = await registry.recordTerminalCellResult({
        threadId,
        cellId: admitted.cellId,
        result: terminalResult,
      });
      assert.deepEqual(recorded, { ok: true, value: { bridgeClosed: true } });
      return registry.closeCell(args);
    },
  };

  const result = await waitForExecuteCodeCell({
    cellRegistry: racingRegistry,
    runContext: { threadId },
    request: { cellId: admitted.cellId, terminate: true },
    signal: undefined,
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      ok: true,
      capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
      policyId: 'ptc_lab_execute_code_batch_node_v1',
      executionSurface: 'node_via_lab_detached_cell',
      status: 'completed',
      cellId: 'ptc_cell_wait_terminate_race',
      exitCode: 0,
      stdout: 'IMPORTANT RESULT\n',
      stderr: '',
    },
  });
  assert.equal(closeCalls, 1);
  assert.equal(registry.readCellState({ threadId }), null);
});

void test('createPtcExecuteCodeRuntime waitForCell terminates a running cell through taint close', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-terminate-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-terminate-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_terminate',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-terminate',
  });
  const exit = deferredExit();
  let terminateCount = 0;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () =>
          makeDetachedSegment({
            stdout: 'before terminate\n',
            stderr: 'stopping\n',
          }),
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(914),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');

    const terminated = await runtime.waitForCell({
      runContext: { threadId: testThreadId(914) },
      request: { cellId: 'ptc_cell_runtime_terminate', terminate: true },
    });

    assert.deepEqual(terminated, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'terminated',
        cellId: 'ptc_cell_runtime_terminate',
        exitCode: null,
        stdout: 'before terminate\n',
        stderr: 'stopping\n',
      },
    });
    assert.equal(terminateCount, 1);
    assert.equal(registry.readCellState({ threadId: testThreadId(914) }), null);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-terminate']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime fails and taints the session when initial cell bridge close fails', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-bridge-close-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-bridge-close-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-bridge-close',
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async (bridgeArgs) => {
      const session = await bridgeArgs.sessionManager.getOrCreate(
        bridgeArgs.identity,
      );
      assert.equal(session.ok, true);
      if (!session.ok) {
        throw new Error('expected session');
      }
      return {
        ok: true,
        value: {
          containerId: session.value.containerId,
          epochId: 'epoch-bridge-close-fails',
          token: 'token-bridge-close-fails',
          callbackSocketHostPath: join(
            session.value.callbackRootHostPath,
            'callback.sock',
          ),
          callbackSocketContainerPath: '/geulbat/callbacks/callback.sock',
          session: session.value,
          close: async () => {
            throw new Error('bridge close failed');
          },
        },
      };
    },
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'done\n' }),
      }),
    }),
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(935),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'return 1' },
      toolCallbackHandler: async () => ({
        ok: true,
        result: { ok: true, output: '' },
      }),
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    if (result.value.executionSurface !== 'node_via_lab_batch_command') {
      return;
    }
    assert.equal(result.value.stdout, 'done\n');
    assert.deepEqual(result.value.cleanupFailure, {
      message: 'PTC execute_code cell cleanup failed after terminal exit',
      diagnostics: {
        callbackBridgeCloseFailed: true,
        callbackBridgeCloseErrorName: 'Error',
      },
    });
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-bridge-close']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports yielded cell bridge cleanup failure through wait', async () => {
  const workspaceRoot = await mkdtemp(
    join(
      tmpdir(),
      'geulbat-ptc-execute-code-cell-yield-bridge-close-workspace-',
    ),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-bridge-close-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_yield_bridge_close',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-yield-bridge-close',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    createEpochBridge: async (bridgeArgs) => {
      const session = await bridgeArgs.sessionManager.getOrCreate(
        bridgeArgs.identity,
      );
      assert.equal(session.ok, true);
      if (!session.ok) {
        throw new Error('expected session');
      }
      return {
        ok: true,
        value: {
          containerId: session.value.containerId,
          epochId: 'epoch-yield-bridge-close-fails',
          token: 'token-yield-bridge-close-fails',
          callbackSocketHostPath: join(
            session.value.callbackRootHostPath,
            'callback.sock',
          ),
          callbackSocketContainerPath: '/geulbat/callbacks/callback.sock',
          session: session.value,
          close: async () => {
            throw new Error('bridge close failed');
          },
        },
      };
    },
    startCellProcess: () => ({
      ok: true,
      handle: makeExitGatedDetachedHandle({
        output: makeDetachedSegment({ stdout: 'background complete\n' }),
        exit: exit.promise,
      }),
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(938),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'return 1' },
      toolCallbackHandler: async () => ({
        ok: true,
        result: { ok: true, output: '' },
      }),
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

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });

    const waited = await runtime.waitForCell({
      runContext: { threadId: testThreadId(938) },
      request: { cellId: 'ptc_cell_yield_bridge_close' },
    });

    assert.equal(waited.ok, true);
    if (!waited.ok) {
      return;
    }
    assert.equal(waited.value.status, 'completed_with_cleanup_failure');
    if (waited.value.status !== 'completed_with_cleanup_failure') {
      return;
    }
    assert.equal(waited.value.stdout, 'background complete\n');
    assert.deepEqual(waited.value.cleanupFailure, {
      message: 'PTC execute_code cell cleanup failed after terminal exit',
      diagnostics: {
        callbackBridgeCloseFailed: true,
        callbackBridgeCloseErrorName: 'Error',
      },
    });
    assert.equal(registry.readCellState({ threadId: testThreadId(938) }), null);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [
        [
          'rm',
          '-f',
          'container-agent-ptc-execute-code-cell-yield-bridge-close',
        ],
      ],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime taints yielded cells that later exit by signal', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-signal-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-yield-signal-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_yield_signal',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-yield-signal',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'before signal\n' }),
        exit: exit.promise,
      }),
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(936),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(result.ok, true);
    exit.resolve({ kind: 'signal', exitCode: null, processTerminated: false });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (registry.readCellState({ threadId: testThreadId(936) }) === null) {
        break;
      }
      await delay(10);
    }

    assert.equal(registry.readCellState({ threadId: testThreadId(936) }), null);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-cell-yield-signal']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports cleanup failure when cell taint close is not proven', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-taint-fail-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-taint-fail-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_taint_close_fail',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-taint-fail',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'rm') {
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'remove failed',
        };
      }
      return undefined;
    },
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () => makeDetachedSegment({ stdout: 'still unsafe\n' }),
        exit: exit.promise,
        terminate: () => {
          exit.resolve({
            kind: 'signal',
            exitCode: null,
            processTerminated: false,
          });
        },
      },
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const first = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(937),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(first.ok, true);

    const terminated = await runtime.waitForCell({
      runContext: { threadId: testThreadId(937) },
      request: { cellId: 'ptc_cell_taint_close_fail', terminate: true },
    });

    assert.equal(terminated.ok, false);
    assert.equal(
      terminated.ok ? '' : terminated.reasonCode,
      'ptc_execute_code_session_cleanup_failed',
    );
    assert.equal(registry.readCellState({ threadId: testThreadId(937) }), null);

    const retry = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(937),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'return 2' },
    });
    assert.equal(retry.ok, false);
    assert.equal(
      retry.ok ? '' : retry.reasonCode,
      'ptc_lab_session_unavailable',
    );
    assert.deepEqual(retry.ok ? undefined : retry.diagnostics, {
      sessionReasonCode: 'container_remove_failed',
    });
    assert.equal(registry.readCellState({ threadId: testThreadId(937) }), null);
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closeAll shuts down the enabled cell registry', async () => {
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_runtime_shutdown',
  });
  let terminateCount = 0;
  const taintReasons: string[] = [];
  const admitted = registry.reserveAdmittingCell({
    threadId: testThreadId(912),
  });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  registry.promoteAdmittedCell({
    threadId: testThreadId(912),
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: {
        drainNewOutput: () => ({
          stdout: 'partial\n',
          stderr: '',
        }),
        exit: Promise.resolve({
          kind: 'signal',
          exitCode: null,
          processTerminated: false,
        }),
        terminate: () => {
          terminateCount += 1;
        },
      },
      closeBridge: () => {},
      taintSession: ({ reason }) => {
        taintReasons.push(reason);
        return true;
      },
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    createCellRegistry: () => registry,
    ptcCell: makeTestCellConfig(1),
  });

  assert.deepEqual(await runtime.closeAll(), { ok: true });
  assert.equal(terminateCount, 1);
  assert.deepEqual(taintReasons, ['shutdown']);
  assert.equal(registry.readCellState({ threadId: testThreadId(912) }), null);
});

function makeDetachedSegment(
  args: Partial<DetachedProcessOutputSegment> = {},
): DetachedProcessOutputSegment {
  return {
    stdout: args.stdout ?? '',
    stderr: args.stderr ?? '',
  };
}

function makeDetachedHandle(args: {
  output: DetachedProcessOutputSegment;
  exit?: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle {
  return {
    drainNewOutput: () => args.output,
    exit:
      args.exit ??
      Promise.resolve({
        kind: 'exit',
        exitCode: 0,
        processTerminated: true,
      }),
    terminate: () => {},
  };
}

function makeExitGatedDetachedHandle(args: {
  output: DetachedProcessOutputSegment;
  exit: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle {
  let exited = false;
  let pending = args.output;
  return {
    drainNewOutput: () => {
      if (!exited) {
        return makeDetachedSegment();
      }
      const output = pending;
      pending = makeDetachedSegment();
      return output;
    },
    exit: args.exit.then((exit) => {
      exited = true;
      return exit;
    }),
    terminate: () => {},
  };
}

function deferredExit(): {
  promise: Promise<DetachedProcessExitInfo>;
  resolve(exit: DetachedProcessExitInfo): void;
} {
  let resolveExit: (exit: DetachedProcessExitInfo) => void;
  const promise = new Promise<DetachedProcessExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  return {
    promise,
    resolve: (exit) => resolveExit(exit),
  };
}

function trackAbortListeners(signal: AbortSignal): {
  listenerCount(): number;
} {
  const activeListeners = new Set<TrackedAbortListener>();
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);

  const trackedAddEventListener: AbortSignal['addEventListener'] = (
    type,
    listener,
    options,
  ) => {
    if (type === 'abort' && listener !== null) {
      activeListeners.add(listener);
    }
    addEventListener(type, listener, options);
  };
  const trackedRemoveEventListener: AbortSignal['removeEventListener'] = (
    type,
    listener,
    options,
  ) => {
    if (type === 'abort' && listener !== null) {
      activeListeners.delete(listener);
    }
    removeEventListener(type, listener, options);
  };

  signal.addEventListener = trackedAddEventListener;
  signal.removeEventListener = trackedRemoveEventListener;

  return {
    listenerCount: () => activeListeners.size,
  };
}

type TrackedAbortListener = NonNullable<
  Parameters<AbortSignal['addEventListener']>[1]
>;

function makeObservableDetachedHandle(args: {
  exit: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle & {
  appendOutput(output: DetachedProcessOutputSegment): void;
} {
  let outputRevision = 0;
  let pending = makeDetachedSegment();
  const outputWaiters = new Set<(nextRevision: number) => void>();

  const bumpOutputRevision = () => {
    outputRevision += 1;
    const waiters = [...outputWaiters];
    outputWaiters.clear();
    for (const waiter of waiters) {
      waiter(outputRevision);
    }
  };

  return {
    appendOutput(output) {
      pending = {
        stdout: pending.stdout + output.stdout,
        stderr: pending.stderr + output.stderr,
      };
      bumpOutputRevision();
    },
    drainNewOutput() {
      const output = pending;
      pending = makeDetachedSegment();
      return output;
    },
    getOutputRevision() {
      return outputRevision;
    },
    waitForOutputChange(afterRevision, abortSignal) {
      if (outputRevision !== afterRevision) {
        return Promise.resolve(outputRevision);
      }

      return new Promise<number>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          outputWaiters.delete(onOutputChange);
          abortSignal?.removeEventListener('abort', onAbort);
          fn();
        };
        const onAbort = () => {
          finish(() => reject(new Error('output wait aborted')));
        };
        const onOutputChange = (nextRevision: number) => {
          finish(() => resolve(nextRevision));
        };

        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        outputWaiters.add(onOutputChange);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    exit: args.exit,
    terminate() {},
  };
}
