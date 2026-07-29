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
  makeExitGatedDetachedHandle,
} from '../../../../test-support/ptc-execute-code-cell-process.js';
import { makeTestPtcExecuteCodeCellConfig as makeTestCellConfig } from '../../../../test-support/ptc-execute-code-runtime-cell.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { createPtcExecuteCodeCellTerminalResultStore } from '../../../ptc-execute-code-terminal-result-store.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeCellCoordinate,
} from './execute-code-runtime-contract.js';
import {
  createPtcExecuteCodeRuntime,
  derivePtcExecuteCodeCellId,
} from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
  ExecuteCodeCellProcessInvocation,
} from './execute-code-cell-process.js';

void test('createPtcExecuteCodeRuntime waitForCell without a yield window wakes when a running cell completes', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(938),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell without a yield window wakes on new running output', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(938_1),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell reports yielded cell output policy rejection', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(938_4),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell reports yielded cell timeout', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(938_5),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime waitForCell ignores unrelated thread revisions', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });
  const ownerThreadId = testThreadId(938_2);
  const unrelatedThreadId = testThreadId(938_3);

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: ownerThreadId,
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime caps initial cell yield by request timeout', async () => {
  const stateRoot = await mkdtemp(
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
  const cellStarts: ExecuteCodeCellProcessInvocation[] = [];
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await Promise.race([
      runtime.executeCode({
        runContext: makeRunContext({
          threadId: testThreadId(931),
          stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports an initial detached cell timeout', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-timeout-workspace-'),
  );
  const firstRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-timeout-runtime-1-'),
  );
  const secondRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-timeout-runtime-2-'),
  );
  const threadId = testThreadId(931_2);
  const invocation = {
    runId: 'run-initial-cell-timeout',
    callId: 'call-initial-cell-timeout',
  };
  let coordinate: PtcExecuteCodeCellCoordinate | undefined;
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
      assert.fail('initial timeout must not publish a running delivery');
    },
  };
  const terminalResultStore = createPtcExecuteCodeCellTerminalResultStore();
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-timeout',
  });
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore: terminalResultStore,
    commandRunner: fixture.runner,
    startCellProcess: (args) => ({
      ok: true,
      handle: makeDetachedHandle({
        outputRef: `command-output:system/${args.cellId}`,
        output: makeDetachedSegment({ stdout: 'still running\n' }),
        exit: Promise.resolve({
          kind: 'timeout',
          exitCode: null,
          processTerminated: false,
        }),
      }),
    }),
    ptcCell: makeTestCellConfig(60_000),
    runtimeRootForState: () => firstRuntimeRoot,
  });
  runtime.attachCellCoordinateStore?.(coordinateStore);
  let restartedRuntime:
    | ReturnType<typeof createPtcExecuteCodeRuntime>
    | undefined;

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: { code: 'await new Promise(() => {})', timeoutMs: 1_000 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
    assert.equal(result.ok ? '' : result.diagnostics?.cellExitKind, 'timeout');
    assert.equal(coordinate, undefined);
    const durable = await terminalResultStore.readRecovery?.({
      stateRoot,
      threadId,
      cellId: derivePtcExecuteCodeCellId({ threadId, ...invocation }),
    });
    assert.notEqual(durable, undefined);
    if (durable === undefined) {
      return;
    }
    assert.equal(durable.ok, true, JSON.stringify(durable));
    assert.deepEqual(durable.ok ? durable.value : undefined, result);

    await runtime.closeAll();
    const restartedFixture = createPtcSessionDockerCommandFixture({
      policy: createPtcSessionDockerLocalBatchCommandPolicy(),
      containerId: 'container-agent-ptc-execute-code-cell-timeout-restarted',
    });
    restartedRuntime = createPtcExecuteCodeRuntime({
      cellTerminalResultStore: terminalResultStore,
      commandRunner: restartedFixture.runner,
      startCellProcess: () => {
        assert.fail('durable timeout recovery must not restart code');
      },
      ptcCell: makeTestCellConfig(60_000),
      runtimeRootForState: () => secondRuntimeRoot,
    });
    restartedRuntime.attachCellCoordinateStore?.(coordinateStore);
    const recovered = await restartedRuntime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      invocation,
      invocationId: invocation.callId,
      request: { code: 'await new Promise(() => {})', timeoutMs: 1_000 },
    });
    assert.deepEqual(recovered, result);
  } finally {
    await restartedRuntime?.closeAll();
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(firstRuntimeRoot, { recursive: true, force: true });
    await rm(secondRuntimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime rejects explicit cell yield beyond the execution timeout', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(931_1),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

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
