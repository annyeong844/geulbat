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
import {
  makeTestPtcExecuteCodeCellConfig as makeTestCellConfig,
  TEST_PTC_EXECUTE_CODE_CALLBACK_TRANSPORT_POLICY as TEST_CALLBACK_TRANSPORT_POLICY,
} from '../../../../test-support/ptc-execute-code-runtime-cell.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { readToolOutputSnapshot } from '../../../files/tool-output-store.js';
import { createPtcExecuteCodeCellTerminalResultStore } from '../../../ptc-execute-code-terminal-result-store.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { PTC_EXECUTE_CODE_TOOL_NAME } from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';

void test('createPtcExecuteCodeRuntime waitForCell terminates a running cell through taint close', async () => {
  const stateRoot = await mkdtemp(
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
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    createEpochBridge: async (bridgeArgs) => {
      assert.deepEqual(
        await bridgeArgs.callbackHandler({
          requestId: 'runtime-terminate-store-set',
          kind: 'store_set',
          args: { key: 'discarded', value: true },
          signal: new AbortController().signal,
          enterLongWait: () => true,
        }),
        { ok: true, result: undefined },
      );
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
          epochId: 'epoch-cell-terminate-store',
          token: 'token-cell-terminate-store',
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
    runtimeRootForState: () => runtimeRoot,
    store: {
      enabled: true,
      maxKeys: 32,
      maxValueBytes: 4_096,
      maxTotalBytes: 32_768,
    },
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(914),
        stateRoot,
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
        store: { discardedWrites: 1 },
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime recovers an explicit termination result after runtime restart', async () => {
  const stateRoot = await mkdtemp(
    join(
      tmpdir(),
      'geulbat-ptc-execute-code-cell-terminate-durable-workspace-',
    ),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-terminate-durable-runtime-'),
  );
  const threadId = testThreadId(914_01);
  const cellId = 'ptc_cell_runtime_terminate_durable' as const;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-terminate-durable',
  });
  const cellTerminalResultStore = createPtcExecuteCodeCellTerminalResultStore();
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    cellTerminalResultStore,
    commandRunner: fixture.runner,
    createCellRegistry: (options) =>
      createPtcExecuteCodeCellRegistry({
        ...options,
        createCellId: () => cellId,
      }),
    startCellProcess: () => ({
      ok: true,
      handle: {
        drainNewOutput: () =>
          makeDetachedSegment({
            stdout: 'durable terminate output\n',
            stderr: 'durable terminate diagnostics\n',
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
    runtimeRootForState: () => runtimeRoot,
  });
  let restartedRuntime:
    | ReturnType<typeof createPtcExecuteCodeRuntime>
    | undefined;

  try {
    const started = await runtime.executeCode({
      runContext: makeRunContext({ threadId, stateRoot }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(started.ok, true);
    if (
      !started.ok ||
      started.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }

    const terminated = await runtime.waitForCell({
      runContext: { threadId, stateRoot },
      request: { cellId, terminate: true },
    });
    assert.equal(terminated.ok, true);
    if (!terminated.ok) {
      return;
    }
    assert.equal(terminated.value.status, 'terminated');
    assert.equal(
      'offloaded' in terminated.value ? terminated.value.offloaded : false,
      true,
    );
    const outputRef = Reflect.get(terminated.value, 'outputRef');
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
      status: 'terminated',
      cellId,
      exitCode: null,
      stdout: 'durable terminate output\n',
      stderr: 'durable terminate diagnostics\n',
    });

    await runtime.closeAll();
    restartedRuntime = createPtcExecuteCodeRuntime({
      cellTerminalResultStore,
      ptcCell: makeTestCellConfig(1),
      startCellProcess: () => {
        assert.fail(
          'explicit termination recovery must not start a cell process',
        );
      },
    });
    const afterRestart = await restartedRuntime.waitForCell({
      runContext: { threadId, stateRoot },
      request: { cellId },
    });
    assert.deepEqual(afterRestart, terminated);
  } finally {
    await restartedRuntime?.closeAll();
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime fails and taints the session when initial cell bridge close fails', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(935),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports yielded cell bridge cleanup failure through wait', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(938),
        stateRoot,
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
    assert.equal('outputRef' in waited.value, false);
    if ('outputRef' in waited.value) {
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime taints yielded cells that later exit by signal', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(936),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports cleanup failure when cell taint close is not proven', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const first = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(937),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(first.ok, true);

    const terminated = await runtime.waitForCell({
      runContext: { threadId: testThreadId(937) },
      request: { cellId: 'ptc_cell_taint_close_fail', terminate: true },
    });

    assert.deepEqual(terminated, {
      ok: true,
      value: {
        ok: true,
        capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
        policyId: 'ptc_lab_execute_code_batch_node_v1',
        executionSurface: 'node_via_lab_detached_cell',
        status: 'terminated_with_cleanup_failure',
        cellId: 'ptc_cell_taint_close_fail',
        exitCode: null,
        stdout: 'still unsafe\n',
        stderr: '',
        cleanupFailure: {
          message: 'PTC execute_code explicit termination cleanup failed',
          diagnostics: {
            sessionCloseFailed: true,
            sessionTainted: true,
          },
        },
      },
    });
    assert.equal(registry.readCellState({ threadId: testThreadId(937) }), null);

    const retry = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(937),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
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
    startCellProcess: () => {
      assert.fail('closing an injected registry must not start a cell process');
    },
  });

  assert.deepEqual(await runtime.closeAll(), { ok: true });
  assert.equal(terminateCount, 1);
  assert.deepEqual(taintReasons, ['shutdown']);
  assert.equal(registry.readCellState({ threadId: testThreadId(912) }), null);
  assert.deepEqual(
    await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(912),
        stateRoot: '/workspace',
      }),
      request: { code: 'console.log("must not restart")' },
    }),
    {
      ok: false,
      reasonCode: 'ptc_lab_session_unavailable',
      message: 'PTC execute_code runtime is shutting down',
      diagnostics: { shutdownState: 'closed', shutdownEpoch: 1 },
    },
  );
  assert.deepEqual(await runtime.closeAll(), { ok: true });
});
