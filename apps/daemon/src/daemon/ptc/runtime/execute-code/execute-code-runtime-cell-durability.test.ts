import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deferredDetachedProcessExit as deferredExit,
  makeDetachedHandle,
  makeDetachedSegment,
  makeExitGatedDetachedHandle,
} from '../../../../test-support/ptc-execute-code-cell-process.js';
import { makeTestPtcExecuteCodeCellConfig as makeTestCellConfig } from '../../../../test-support/ptc-execute-code-runtime-cell.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { readToolOutputSnapshot } from '../../../files/tool-output-store.js';
import { createPtcExecuteCodeCellTerminalResultStore } from '../../../ptc-execute-code-terminal-result-store.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import type {
  PtcExecuteCodePlacementCoordinator,
  PtcExecuteCodeSettledPlacementAcquireResult,
} from './execute-code-placement-contract.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeCellCoordinate,
  type PtcExecuteCodeCellTerminalResultStore,
} from './execute-code-runtime-contract.js';
import {
  createPtcExecuteCodeRuntime,
  derivePtcExecuteCodeCellId,
} from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import type { DetachedProcessHandle } from './execute-code-cell-process.js';

void test('createPtcExecuteCodeRuntime returns a running cell summary when the enabled detached branch yields first', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(913),
        stateRoot,
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
      runContext: makeRunContext({
        threadId: testThreadId(913),
        stateRoot,
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
      runContext: makeRunContext({
        threadId: testThreadId(913),
        stateRoot,
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
      runContext: makeRunContext({
        threadId: testThreadId(913),
        stateRoot,
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
      runContext: makeRunContext({
        threadId: testThreadId(913),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime recovers a background terminal result after memory reap and runtime restart', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-durable-result-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-durable-result-runtime-'),
  );
  const threadId = testThreadId(913_01);
  const exit = deferredExit();
  let now = 10_000;
  const scheduled: Array<{
    callback: () => Promise<void> | void;
    delayMs: number;
  }> = [];
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-durable-result',
  });
  const cellTerminalResultStore = createPtcExecuteCodeCellTerminalResultStore();
  let registry: ReturnType<typeof createPtcExecuteCodeCellRegistry> | undefined;
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore,
    commandRunner: fixture.runner,
    createCellRegistry: (options) => {
      registry = createPtcExecuteCodeCellRegistry({
        ...options,
        createCellId: () => 'ptc_cell_runtime_durable_result',
        now: () => now,
        terminalResultMemoryRetentionMs: 10,
        scheduleReapTimeout: (callback, delayMs) => {
          const entry = { callback, delayMs };
          scheduled.push(entry);
          return () => {
            const index = scheduled.indexOf(entry);
            if (index >= 0) {
              scheduled.splice(index, 1);
            }
          };
        },
      });
      return registry;
    },
    startCellProcess: () => ({
      ok: true,
      handle: makeDetachedHandle({
        output: makeDetachedSegment({ stdout: 'durable result\n' }),
        exit: exit.promise,
      }),
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
  });
  let restartedRuntime:
    | ReturnType<typeof createPtcExecuteCodeRuntime>
    | undefined;

  try {
    const started = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      request: { code: 'await background_work', timeoutMs: 60_000 },
    });
    assert.equal(started.ok, true);
    if (
      !started.ok ||
      started.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }
    assert.equal(started.value.status, 'running');
    assert.notEqual(registry, undefined);
    if (registry === undefined) {
      return;
    }

    const runningRevision = registry.getThreadRevision({ threadId });
    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    await registry.waitForThreadRevisionChange({
      threadId,
      afterRevision: runningRevision,
    });
    const retentionReap = scheduled.find((entry) => entry.delayMs === 10);
    assert.notEqual(retentionReap, undefined);
    if (retentionReap === undefined) {
      return;
    }
    now = 10_010;
    await retentionReap.callback();

    const waited = await runtime.waitForCell({
      runContext: { threadId, stateRoot },
      request: { cellId: started.value.cellId },
    });
    assert.equal(waited.ok, true);
    if (!waited.ok) {
      return;
    }
    assert.equal(waited.value.status, 'completed');
    const outputRef = Reflect.get(waited.value, 'outputRef');
    assert.equal(typeof outputRef, 'string');
    if (typeof outputRef !== 'string') {
      return;
    }
    const snapshot = await readToolOutputSnapshot({
      stateRoot,
      threadId,
      outputRef,
    });
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) {
      return;
    }
    assert.deepEqual(JSON.parse(snapshot.value.output), {
      kind: 'ptc_execute_code_cell_wait',
      capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
      policyId: 'ptc_lab_execute_code_batch_node_v1',
      executionSurface: 'node_via_lab_detached_cell',
      status: 'completed',
      cellId: 'ptc_cell_runtime_durable_result',
      exitCode: 0,
      stdout: 'durable result\n',
      stderr: '',
    });

    await runtime.closeAll();
    restartedRuntime = createPtcExecuteCodeRuntime({
      cellTerminalResultStore,
      ptcCell: makeTestCellConfig(1),
      startCellProcess: () => {
        assert.fail('durable result recovery must not start a cell process');
      },
    });
    const afterRestart = await restartedRuntime.waitForCell({
      runContext: { threadId, stateRoot },
      request: { cellId: started.value.cellId },
    });
    assert.deepEqual(afterRestart, waited);
  } finally {
    await restartedRuntime?.closeAll();
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime replays the same durable running wait delivery without touching a cell process', async () => {
  const threadId = testThreadId(913_015);
  const cellId = 'ptc_cell_runtime_wait_delivery' as const;
  const delivery = {
    threadId,
    runId: 'run-wait-delivery',
    callId: 'call-wait-delivery',
    cellId,
    stdout: 'durable running output\n',
    stderr: '',
    outputReadOffsets: {
      stdoutBytes: 23,
      stderrBytes: 0,
    },
  };
  let deleted = false;
  let processStarts = 0;
  const runtime = createPtcExecuteCodeRuntime({
    ptcCell: makeTestCellConfig(1),
    startCellProcess: () => {
      processStarts += 1;
      assert.fail('running wait delivery recovery must not start a process');
    },
  });
  runtime.attachCellCoordinateStore?.({
    listPtcExecuteCodeCellCoordinates: () => [],
    persistPtcExecuteCodeCellCoordinate() {},
    deletePtcExecuteCodeCellCoordinate() {},
    readPtcExecuteCodeRunningWaitDelivery: () =>
      deleted ? undefined : delivery,
    persistPtcExecuteCodeRunningWaitDelivery() {
      assert.fail('recovery must reuse the existing wait delivery');
    },
    deletePtcExecuteCodeRunningWaitDelivery() {
      deleted = true;
    },
  });

  try {
    const recovered = await runtime.waitForCell({
      runContext: { threadId },
      invocation: {
        runId: delivery.runId,
        callId: delivery.callId,
      },
      request: { cellId },
    });
    assert.deepEqual(recovered, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'running',
        cellId,
        stdout: delivery.stdout,
        stderr: delivery.stderr,
      },
    });
    assert.equal(processStarts, 0);
    assert.equal(deleted, false);

    const nextCall = await runtime.waitForCell({
      runContext: { threadId },
      invocation: {
        runId: delivery.runId,
        callId: 'call-wait-delivery-next',
      },
      request: { cellId },
    });
    assert.equal(nextCall.ok, true);
    assert.equal(nextCall.ok ? nextCall.value.status : '', 'missing');
    assert.equal(deleted, true);
    assert.equal(processStarts, 0);
  } finally {
    await runtime.closeAll();
  }
});

void test('createPtcExecuteCodeRuntime replays the same durable running exec delivery without starting another cell', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-exec-delivery-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-exec-delivery-runtime-'),
  );
  const threadId = testThreadId(913_016);
  const invocation = {
    runId: 'run-exec-delivery',
    callId: 'call-exec-delivery',
  };
  const cellId = derivePtcExecuteCodeCellId({ threadId, ...invocation });
  const delivery = {
    threadId,
    ...invocation,
    cellId,
    stdout: 'durable initial output\n',
    stderr: 'durable initial diagnostic\n',
    durationMs: 37,
    toolCallbackCount: 2,
    outputReadOffsets: {
      stdoutBytes: 23,
      stderrBytes: 27,
    },
  };
  let processStarts = 0;
  let execDeliveryDeleted = false;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-exec-delivery',
  });
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: {
      async persist() {
        assert.fail('the running fixture must not persist a terminal result');
      },
      async read() {
        return { ok: true, value: undefined };
      },
    },
    commandRunner: fixture.runner,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
    startCellProcess: () => {
      processStarts += 1;
      assert.fail('durable exec delivery recovery must not start a process');
    },
  });
  runtime.attachCellCoordinateStore?.({
    listPtcExecuteCodeCellCoordinates: () => [],
    persistPtcExecuteCodeCellCoordinate() {},
    deletePtcExecuteCodeCellCoordinate() {},
    readPtcExecuteCodeRunningExecDelivery: () =>
      execDeliveryDeleted ? undefined : delivery,
    persistPtcExecuteCodeRunningExecDelivery() {
      assert.fail('recovery must reuse the existing exec delivery');
    },
    deletePtcExecuteCodeRunningExecDelivery() {
      execDeliveryDeleted = true;
    },
  });

  try {
    const recovered = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: {
        code: 'await new Promise(() => {})',
        timeoutMs: 60_000,
      },
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    if (!recovered.ok) {
      return;
    }
    assert.equal(
      recovered.value.executionSurface,
      'node_via_lab_detached_cell',
    );
    assert.equal(recovered.value.status, 'running');
    assert.equal(recovered.value.cellId, cellId);
    assert.equal(recovered.value.stdout, delivery.stdout);
    assert.equal(recovered.value.stderr, delivery.stderr);
    assert.equal(recovered.value.durationMs, delivery.durationMs);
    assert.equal(recovered.value.toolCallbacks.observed, 2);
    assert.equal(processStarts, 0);

    const waited = await runtime.waitForCell({
      runContext: { threadId, stateRoot },
      request: { cellId },
    });
    assert.equal(waited.ok, true);
    assert.equal(waited.ok ? waited.value.status : '', 'missing');
    assert.equal(execDeliveryDeleted, true);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime refuses to duplicate an exec with retained terminal output', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-terminal-exec-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-terminal-exec-runtime-'),
  );
  const threadId = testThreadId(913_017);
  const invocation = {
    runId: 'run-terminal-exec',
    callId: 'call-terminal-exec',
  };
  const cellId = derivePtcExecuteCodeCellId({ threadId, ...invocation });
  let processStarts = 0;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-terminal-exec',
  });
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: {
      async persist() {
        assert.fail('recovery must not replace retained terminal output');
      },
      async read(args) {
        assert.deepEqual(args, { stateRoot, threadId, cellId });
        return {
          ok: true,
          value: {
            outputRef: 'tool-output:ptc-terminal-exec',
            fullOutputBytes: 128,
            fullOutputChars: 128,
            status: 'completed',
            exitCode: 0,
          },
        };
      },
    },
    commandRunner: fixture.runner,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
    startCellProcess: () => {
      processStarts += 1;
      assert.fail('retained terminal exec recovery must not start a process');
    },
  });
  runtime.attachCellCoordinateStore?.({
    listPtcExecuteCodeCellCoordinates: () => [],
    persistPtcExecuteCodeCellCoordinate() {
      assert.fail('recovery must not publish a replacement coordinate');
    },
    deletePtcExecuteCodeCellCoordinate() {},
    readPtcExecuteCodeRunningExecDelivery: () => undefined,
    persistPtcExecuteCodeRunningExecDelivery() {
      assert.fail('recovery must not persist a replacement delivery');
    },
  });

  try {
    const recovered = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: {
        code: 'process.stdout.write("must not run")',
        timeoutMs: 60_000,
      },
    });
    assert.equal(recovered.ok, false);
    if (recovered.ok) {
      return;
    }
    assert.equal(recovered.reasonCode, 'ptc_execute_code_store_unavailable');
    assert.match(recovered.message, /starting duplicate code/u);
    assert.equal(
      recovered.diagnostics?.['terminalOutputRef'],
      'tool-output:ptc-terminal-exec',
    );
    assert.equal(recovered.diagnostics?.['terminalStatus'], 'completed');
    assert.equal(recovered.diagnostics?.['terminalExitCode'], 0);
    assert.equal(processStarts, 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime replays the exact early terminal exec result after restart', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-terminal-replay-workspace-'),
  );
  const firstRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-terminal-replay-runtime-1-'),
  );
  const secondRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-terminal-replay-runtime-2-'),
  );
  const threadId = testThreadId(9_130_171);
  const invocation = {
    runId: 'run-terminal-exec-replay',
    callId: 'call-terminal-exec-replay',
  };
  const cellId = derivePtcExecuteCodeCellId({ threadId, ...invocation });
  const terminalResultStore = createPtcExecuteCodeCellTerminalResultStore();
  let coordinate: PtcExecuteCodeCellCoordinate | undefined;
  let processStarts = 0;
  const coordinateStore = {
    listPtcExecuteCodeCellCoordinates: () =>
      coordinate === undefined ? [] : [coordinate],
    persistPtcExecuteCodeCellCoordinate(
      nextCoordinate: PtcExecuteCodeCellCoordinate,
    ) {
      coordinate = nextCoordinate;
    },
    deletePtcExecuteCodeCellCoordinate() {
      coordinate = undefined;
    },
    readPtcExecuteCodeRunningExecDelivery: () => undefined,
    persistPtcExecuteCodeRunningExecDelivery() {
      assert.fail('early terminal exec must not publish a running delivery');
    },
  };
  const firstFixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-terminal-replay-1',
  });
  const firstRuntime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: terminalResultStore,
    commandRunner: firstFixture.runner,
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForState: () => firstRuntimeRoot,
    startCellProcess: (args) => {
      processStarts += 1;
      return {
        ok: true,
        handle: makeDetachedHandle({
          outputRef: `command-output:system/${args.cellId}`,
          output: makeDetachedSegment({
            stdout: 'completed before initial yield\n',
          }),
        }),
      };
    },
  });
  firstRuntime.attachCellCoordinateStore?.(coordinateStore);
  const secondFixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-terminal-replay-2',
  });
  const secondRuntime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: terminalResultStore,
    commandRunner: secondFixture.runner,
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForState: () => secondRuntimeRoot,
    startCellProcess: () => {
      processStarts += 1;
      assert.fail('terminal replay must not start replacement code');
    },
  });
  secondRuntime.attachCellCoordinateStore?.(coordinateStore);

  try {
    const original = await firstRuntime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: {
        code: 'process.stdout.write("completed before initial yield")',
        timeoutMs: 60_000,
      },
    });
    assert.equal(original.ok, true, JSON.stringify(original));
    assert.equal(coordinate, undefined);
    assert.equal(processStarts, 1);

    await firstRuntime.closeAll();
    const recovered = await secondRuntime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: {
        code: 'process.stdout.write("completed before initial yield")',
        timeoutMs: 60_000,
      },
    });
    assert.deepEqual(recovered, original);
    assert.equal(processStarts, 1);
    assert.equal(
      recovered.ok ? recovered.value.executionSurface : '',
      'node_via_lab_batch_command',
    );
    assert.equal(
      recovered.ok ? recovered.value.stdout : '',
      'completed before initial yield\n',
    );
    assert.equal(
      cellId,
      derivePtcExecuteCodeCellId({ threadId, ...invocation }),
    );
  } finally {
    await firstRuntime.closeAll();
    await secondRuntime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(firstRuntimeRoot, { recursive: true, force: true });
    await rm(secondRuntimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime restarts a queued invocation with the same cell id and one eventual process start', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-queued-restart-workspace-'),
  );
  const firstRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-queued-restart-first-'),
  );
  const secondRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-queued-restart-second-'),
  );
  const threadId = testThreadId(913_018);
  const invocation = {
    runId: 'run-queued-restart',
    callId: 'call-queued-restart',
  };
  const cellId = derivePtcExecuteCodeCellId({ threadId, ...invocation });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-queued-restart',
  });
  let settleQueuedPlacement:
    | ((result: PtcExecuteCodeSettledPlacementAcquireResult) => void)
    | undefined;
  const waitForPlacement =
    new Promise<PtcExecuteCodeSettledPlacementAcquireResult>((resolve) => {
      settleQueuedPlacement = resolve;
    });
  const createQueuedPlacementCoordinator =
    (): PtcExecuteCodePlacementCoordinator => ({
      acquirePlacement: () => ({
        ok: true,
        queued: true,
        queueId: 'ptc_placement_queue_restart',
        cancel: () =>
          settleQueuedPlacement?.({
            ok: false,
            reasonCode: 'ptc_lab_session_busy',
            message: 'queued placement owner stopped',
            diagnostics: { placementLane: 'queued_restart_test' },
          }),
        waitForPlacement,
        diagnostics: { placementLane: 'queued_restart_test' },
      }),
      releasePlacement() {
        assert.fail('an unstarted queued placement has no lease to release');
      },
      beginShutdown() {},
      finishShutdown() {},
    });
  const terminalResultStore: PtcExecuteCodeCellTerminalResultStore = {
    async persist(args) {
      return {
        outputRef: `tool-output:${args.cellId}`,
        fullOutputBytes: Buffer.byteLength(args.output),
        fullOutputChars: args.output.length,
        status: args.status,
        exitCode: args.exitCode,
      };
    },
    async read() {
      return { ok: true as const, value: undefined };
    },
    async persistRecovery() {},
    async readRecovery() {
      return { ok: true as const, value: undefined };
    },
  };
  const coordinateStore = {
    listPtcExecuteCodeCellCoordinates: () => [],
    persistPtcExecuteCodeCellCoordinate() {},
    deletePtcExecuteCodeCellCoordinate() {},
    readPtcExecuteCodeRunningExecDelivery: () => undefined,
    persistPtcExecuteCodeRunningExecDelivery() {},
  };
  let firstProcessStarts = 0;
  const firstRuntime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: terminalResultStore,
    commandRunner: fixture.runner,
    createPlacementCoordinator: createQueuedPlacementCoordinator,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => firstRuntimeRoot,
    startCellProcess: () => {
      firstProcessStarts += 1;
      assert.fail('the first daemon must not start a queued cell');
    },
  });
  firstRuntime.attachCellCoordinateStore?.(coordinateStore);

  let secondProcessStarts = 0;
  const startedCellIds: string[] = [];
  const secondRuntime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: terminalResultStore,
    commandRunner: fixture.runner,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => secondRuntimeRoot,
    startCellProcess: (args) => {
      secondProcessStarts += 1;
      startedCellIds.push(args.cellId);
      return {
        ok: true,
        handle: makeDetachedHandle({
          outputRef: `command-output:system/${args.cellId}`,
          output: makeDetachedSegment({ stdout: 'started once\n' }),
        }),
      };
    },
  });
  secondRuntime.attachCellCoordinateStore?.(coordinateStore);

  try {
    const queued = await firstRuntime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: { code: 'process.stdout.write("started once")' },
    });
    assert.equal(queued.ok, true);
    assert.equal(
      queued.ok &&
        queued.value.executionSurface === 'node_via_lab_detached_cell'
        ? queued.value.status
        : '',
      'queued',
    );
    assert.equal(
      queued.ok &&
        queued.value.executionSurface === 'node_via_lab_detached_cell'
        ? queued.value.cellId
        : '',
      cellId,
    );
    assert.equal(firstProcessStarts, 0);

    const recovered = await secondRuntime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: { code: 'process.stdout.write("started once")' },
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.deepEqual(startedCellIds, [cellId]);
    assert.equal(secondProcessStarts, 1);
  } finally {
    await firstRuntime.closeAll();
    await secondRuntime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(firstRuntimeRoot, { recursive: true, force: true });
    await rm(secondRuntimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime persists initial running output before releasing its prepared pages', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-exec-linearization-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-exec-linearization-runtime-'),
  );
  const threadId = testThreadId(913_019);
  const invocation = {
    runId: 'run-exec-linearization',
    callId: 'call-exec-linearization',
  };
  const cellId = derivePtcExecuteCodeCellId({ threadId, ...invocation });
  const exit = deferredExit();
  const order: string[] = [];
  let deliveryPersisted = false;
  let preparedCommitted = false;
  const handle: DetachedProcessHandle = {
    outputRef: 'command-output:system/ptc-exec-linearization',
    drainNewOutput: () =>
      preparedCommitted
        ? { stdout: '', stderr: '' }
        : { stdout: 'initial output\n', stderr: 'initial diagnostic\n' },
    prepareOutputDelivery: () => {
      order.push('prepare');
      return {
        output: {
          stdout: 'initial output\n',
          stderr: 'initial diagnostic\n',
        },
        offsets: {
          stdoutBytes: 15,
          stderrBytes: 19,
        },
      };
    },
    commitPreparedOutputDelivery: () => {
      assert.equal(deliveryPersisted, true);
      preparedCommitted = true;
      order.push('commit');
    },
    exit: exit.promise,
    terminate: () => {
      exit.resolve({
        kind: 'exit',
        exitCode: 0,
        processTerminated: true,
      });
    },
  };
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-exec-linearization',
  });
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: {
      async persist() {
        assert.fail('the running fixture must not persist a terminal result');
      },
      async read() {
        return { ok: true, value: undefined };
      },
    },
    commandRunner: fixture.runner,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
    startCellProcess: () => ({ ok: true, handle }),
  });
  runtime.attachCellCoordinateStore?.({
    listPtcExecuteCodeCellCoordinates: () => [],
    persistPtcExecuteCodeCellCoordinate(coordinate) {
      assert.equal(coordinate.cellId, cellId);
      order.push('coordinate');
    },
    deletePtcExecuteCodeCellCoordinate() {},
    readPtcExecuteCodeRunningExecDelivery: () => undefined,
    persistPtcExecuteCodeRunningExecDelivery(delivery) {
      assert.equal(delivery.cellId, cellId);
      assert.deepEqual(delivery.outputReadOffsets, {
        stdoutBytes: 15,
        stderrBytes: 19,
      });
      assert.equal(preparedCommitted, false);
      deliveryPersisted = true;
      order.push('delivery');
    },
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: {
        code: 'await new Promise(() => {})',
        timeoutMs: 60_000,
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_detached_cell');
    assert.equal(result.value.status, 'running');
    assert.equal(result.value.cellId, cellId);
    assert.deepEqual(order.slice(0, 4), [
      'coordinate',
      'prepare',
      'delivery',
      'commit',
    ]);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime retains an unclaimed result when its durable handoff fails', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-handoff-failure-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-handoff-failure-runtime-'),
  );
  await writeFile(join(stateRoot, '.geulbat'), 'not a directory', 'utf8');
  const threadId = testThreadId(913_02);
  const exit = deferredExit();
  let now = 20_000;
  const scheduled: Array<{
    callback: () => Promise<void> | void;
    delayMs: number;
  }> = [];
  let registry: ReturnType<typeof createPtcExecuteCodeCellRegistry> | undefined;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-handoff-failure',
  });
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: createPtcExecuteCodeCellTerminalResultStore(),
    commandRunner: fixture.runner,
    createCellRegistry: (options) => {
      registry = createPtcExecuteCodeCellRegistry({
        ...options,
        createCellId: () => 'ptc_cell_runtime_handoff_failure',
        now: () => now,
        terminalResultMemoryRetentionMs: 10,
        scheduleReapTimeout: (callback, delayMs) => {
          const entry = { callback, delayMs };
          scheduled.push(entry);
          return () => {
            const index = scheduled.indexOf(entry);
            if (index >= 0) {
              scheduled.splice(index, 1);
            }
          };
        },
      });
      return registry;
    },
    startCellProcess: () => ({
      ok: true,
      handle: makeExitGatedDetachedHandle({
        output: makeDetachedSegment({ stdout: 'retained after failure\n' }),
        exit: exit.promise,
      }),
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
  });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];

  try {
    const started = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      request: { code: 'await background_work', timeoutMs: 60_000 },
    });
    assert.equal(started.ok, true);
    if (
      !started.ok ||
      started.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }
    assert.equal(started.value.status, 'running');
    assert.notEqual(registry, undefined);
    if (registry === undefined) {
      return;
    }

    const runningRevision = registry.getThreadRevision({ threadId });
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    await registry.waitForThreadRevisionChange({
      threadId,
      afterRevision: runningRevision,
    });
    now = 20_010;

    assert.equal(
      scheduled.some((entry) => entry.delayMs === 10),
      false,
    );
    assert.deepEqual(registry.readCellState({ threadId }), {
      cellId: 'ptc_cell_runtime_handoff_failure',
      state: 'terminal_retained',
    });
    const blocked = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      request: { code: 'return 2', timeoutMs: 60_000 },
    });
    assert.equal(blocked.ok, false);
    assert.equal(
      blocked.ok ? '' : blocked.reasonCode,
      'ptc_execute_code_cell_result_unclaimed',
    );

    const waited = await runtime.waitForCell({
      runContext: { threadId, stateRoot },
      request: { cellId: started.value.cellId },
    });
    assert.equal(waited.ok, true);
    if (!waited.ok || 'outputRef' in waited.value) {
      return;
    }
    assert.equal(waited.value.status, 'completed');
    if (waited.value.status !== 'completed') {
      return;
    }
    assert.equal(waited.value.stdout, 'retained after failure\n');
    assert.equal(warnings.length, 1);
    assert.match(
      String(warnings[0]?.[0]),
      /failed to persist PTC execute_code terminal result/,
    );
  } finally {
    console.warn = originalWarn;
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
