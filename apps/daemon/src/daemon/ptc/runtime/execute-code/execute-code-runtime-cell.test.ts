import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { readToolOutputSnapshot } from '../../../files/tool-output-store.js';
import { createPtcExecuteCodeCellTerminalResultStore } from '../../../ptc-execute-code-terminal-result-store.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { createPtcExecuteCodePlacementCoordinator } from './execute-code-placement.js';
import {
  createPtcExecuteCodeCallbackEffectPolicy,
  type PtcExecuteCodePlacementCoordinator,
  type PtcExecuteCodeSettledPlacementAcquireResult,
} from './execute-code-placement-contract.js';
import { waitForExecuteCodeCell } from './execute-code-cell-wait.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeCellCoordinate,
  type PtcExecuteCodeCellTerminalResultStore,
} from './execute-code-runtime-contract.js';
import {
  createPtcExecuteCodeRuntime,
  derivePtcExecuteCodeCellId,
} from './execute-code-runtime.js';
import { createPtcExecuteCodeStore } from './execute-code-store.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM } from '../../lab/profile/lab-profile-contract.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
  ExecuteCodeCellProcessInvocation,
} from './execute-code-cell-process.js';

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

void test('createPtcExecuteCodeRuntime refuses an enabled cell lane without an external process owner', () => {
  assert.throws(
    () =>
      createPtcExecuteCodeRuntime({
        ptcCell: makeTestCellConfig(1),
      }),
    /requires an explicit external process starter/u,
  );
});

void test('createPtcExecuteCodeRuntime leaves the cell registry dormant when ptcCell is disabled', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(910),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
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
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-complete-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-complete-runtime-'),
  );
  const cellStarts: ExecuteCodeCellProcessInvocation[] = [];
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(911),
        stateRoot,
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
      runContext: makeRunContext({
        threadId: testThreadId(911),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime commits detached-cell store callbacks before the next cell starts', async () => {
  const stateRoot = await mkdtemp(
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
  let expectedBridgeMarkers: readonly string[] | undefined;
  let callbackRound = 0;
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async (bridgeArgs) => {
      callbackRound += 1;
      const callbackResult = await bridgeArgs.callbackHandler({
        requestId: 'runtime-callback-read-1',
        kind: 'geulbat_tool_call',
        args: { toolName: 'read_file', args: { path: 'note.txt' } },
        signal: new AbortController().signal,
        enterLongWait: () => true,
      });
      assert.equal(callbackResult.ok, true);
      if (callbackRound === 1) {
        const storeSetResult = await bridgeArgs.callbackHandler({
          requestId: 'runtime-callback-store-set-1',
          kind: 'store_set',
          args: { key: 'note', value: 'from detached cell' },
          signal: new AbortController().signal,
          enterLongWait: () => true,
        });
        assert.deepEqual(storeSetResult, { ok: true, result: undefined });
      }
      const storeCallbackResult = await bridgeArgs.callbackHandler({
        requestId: `runtime-callback-store-get-${callbackRound}`,
        kind: 'store_get',
        args: { key: 'note' },
        signal: new AbortController().signal,
        enterLongWait: () => true,
      });
      assert.deepEqual(storeCallbackResult, {
        ok: true,
        result: 'from detached cell',
      });
      const session = await bridgeArgs.sessionManager.getOrCreate(
        bridgeArgs.identity,
      );
      assert.equal(session.ok, true);
      if (!session.ok) {
        throw new Error('expected session');
      }
      const bridge = {
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
      };
      expectedBridgeMarkers = [
        bridge.token,
        bridge.callbackSocketContainerPath,
        bridge.callbackSocketHostPath,
      ];
      return {
        ok: true,
        value: bridge,
      };
    },
    startCellProcess: (invocation) => {
      assert.deepEqual(invocation.redactionMarkers, expectedBridgeMarkers);
      assert.equal(invocation.redactionReplacement, '[redacted:ptc-callback]');
      return {
        ok: true,
        handle: makeDetachedHandle({
          output: makeDetachedSegment({ stdout: 'cell completed\n' }),
        }),
      };
    },
    ptcCell: makeTestCellConfig(60_000),
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
        threadId: testThreadId(911_1),
        stateRoot,
      }),
      request: { code: 'console.log("cell callback")' },
      toolCallbackHandler: async (invocation) => {
        observedCellId = invocation.cellId;
        return { ok: true, result: { ok: true, output: 'callback ok' } };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(observedCellId?.startsWith('ptc_cell_'), true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    if (result.value.executionSurface !== 'node_via_lab_batch_command') {
      return;
    }
    assert.deepEqual(result.value.store, {
      committedKeys: ['note'],
      revisions: { note: 1 },
    });

    const nextResult = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(911_1),
        stateRoot,
      }),
      request: { code: 'console.log("next cell")' },
      toolCallbackHandler: async (invocation) => {
        observedCellId = invocation.cellId;
        return { ok: true, result: { ok: true, output: 'callback ok' } };
      },
    });
    assert.equal(nextResult.ok, true);
    if (!nextResult.ok) {
      return;
    }
    assert.equal(
      nextResult.value.executionSurface,
      'node_via_lab_batch_command',
    );
    if (nextResult.value.executionSurface !== 'node_via_lab_batch_command') {
      return;
    }
    assert.deepEqual(nextResult.value.store, {
      committedKeys: [],
      revisions: {},
    });
    assert.equal(callbackRound, 2);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime commits a yielded detached-cell store write before wait returns', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-store-wait-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-store-wait-runtime-'),
  );
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_store_wait',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-store-wait',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    createEpochBridge: async (bridgeArgs) => {
      assert.deepEqual(
        await bridgeArgs.callbackHandler({
          requestId: 'runtime-store-wait-set',
          kind: 'store_set',
          args: { key: 'after-wait', value: 42 },
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
          epochId: 'epoch-cell-store-wait',
          token: 'token-cell-store-wait',
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
      handle: makeExitGatedDetachedHandle({
        output: makeDetachedSegment({ stdout: 'async cell completed\n' }),
        exit: exit.promise,
      }),
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
    const started = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(911_2),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    assert.equal(started.value.executionSurface, 'node_via_lab_detached_cell');
    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });

    assert.deepEqual(
      await runtime.waitForCell({
        runContext: { threadId: testThreadId(911_2) },
        request: { cellId: 'ptc_cell_store_wait' },
      }),
      {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: 'ptc_lab_execute_code_batch_node_v1',
          executionSurface: 'node_via_lab_detached_cell',
          status: 'completed',
          cellId: 'ptc_cell_store_wait',
          exitCode: 0,
          stdout: 'async cell completed\n',
          stderr: '',
          store: {
            committedKeys: ['after-wait'],
            revisions: { 'after-wait': 1 },
          },
        },
      },
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports a yielded detached-cell store conflict through wait', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-store-conflict-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cell-store-conflict-runtime-'),
  );
  const storeRoot = join(runtimeRoot, 'store');
  const storeConfig = {
    enabled: true,
    maxKeys: 32,
    maxValueBytes: 4_096,
    maxTotalBytes: 32_768,
  } as const;
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_store_conflict',
  });
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cell-store-conflict',
  });
  const exit = deferredExit();
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createCellRegistry: () => registry,
    createEpochBridge: async (bridgeArgs) => {
      assert.deepEqual(
        await bridgeArgs.callbackHandler({
          requestId: 'runtime-store-conflict-set',
          kind: 'store_set',
          args: { key: 'shared', value: 'from cell' },
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
          epochId: 'epoch-cell-store-conflict',
          token: 'token-cell-store-conflict',
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
      handle: makeExitGatedDetachedHandle({
        output: makeDetachedSegment({ stdout: 'cell exited zero\n' }),
        exit: exit.promise,
      }),
    }),
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
    store: storeConfig,
    storeRootForState: () => storeRoot,
  });

  try {
    const started = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(911_3),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})' },
    });
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    const external = await createPtcExecuteCodeStore({
      rootDir: storeRoot,
      config: storeConfig,
    }).beginExecution({
      threadId: testThreadId(911_3),
      executionId: 'external-writer',
    });
    assert.equal(external.ok, true);
    if (!external.ok) {
      return;
    }
    assert.equal(external.value.set('shared', 'from outside').ok, true);
    assert.equal((await external.value.commit()).ok, true);

    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    const waited = await runtime.waitForCell({
      runContext: { threadId: testThreadId(911_3) },
      request: { cellId: 'ptc_cell_store_conflict' },
    });
    assert.equal(waited.ok, false);
    if (waited.ok) {
      return;
    }
    assert.equal(waited.reasonCode, 'ptc_execute_code_store_commit_conflict');
    assert.deepEqual(waited.store, { discardedWrites: 1 });
    assert.equal(waited.storeError?.errorCode, 'StoreCommitConflict');
    assert.deepEqual(waited.storeError?.details, {
      conflicts: [
        {
          key: 'shared',
          baseRevision: 0,
          currentRevision: 1,
          lastWriterExecutionId: 'external-writer',
        },
      ],
    });
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime removes the initial abort listener after fast cell exit', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(912_1),
        stateRoot,
      }),
      request: { code: 'console.log("cell exits quickly")' },
      signal: controller.signal,
    });

    assert.equal(result.ok, true);
    assert.equal(abortListeners.listenerCount(), 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keeps only the owner abort listener after initial yield', async () => {
  const stateRoot = await mkdtemp(
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
  let registry: ReturnType<typeof createPtcExecuteCodeCellRegistry> | undefined;
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    createCellRegistry: (options) => {
      registry = createPtcExecuteCodeCellRegistry(options);
      return registry;
    },
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(912_2),
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
    assert.equal(abortListeners.listenerCount(), 1);
    assert.notEqual(registry, undefined);
    if (registry === undefined) {
      return;
    }

    const runningRevision = registry.getThreadRevision({
      threadId: testThreadId(912_2),
    });
    exit.resolve({ kind: 'exit', exitCode: 0, processTerminated: true });
    await registry.waitForThreadRevisionChange({
      threadId: testThreadId(912_2),
      afterRevision: runningRevision,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abortListeners.listenerCount(), 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

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

void test('createPtcExecuteCodeRuntime aborts the initial cell wait and taints the session', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(932),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes callback-created sessions after cell bridge setup fails', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(933),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime taint-closes the session when cell promotion is lost', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(933_1),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime sanitizes detached cell output before returning it', async () => {
  const stateRoot = await mkdtemp(
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
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(934),
        stateRoot,
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
    await rm(stateRoot, { recursive: true, force: true });
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

void test('waitForExecuteCodeCell checkpoints prepared running output before release and retries it after persistence failure', async () => {
  const threadId = testThreadId(914_01);
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_wait_delivery_linearized',
  });
  const admitted = registry.reserveAdmittingCell({ threadId });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  const order: string[] = [];
  let commitCount = 0;
  registry.promoteAdmittedCell({
    threadId,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: {
        drainNewOutput() {
          assert.fail(
            'durable wait must prepare output instead of draining it',
          );
        },
        prepareOutputDelivery() {
          order.push('prepare');
          return {
            output: {
              stdout: 'checkpoint before release\n',
              stderr: '',
            },
            offsets: {
              stdoutBytes: 26,
              stderrBytes: 0,
            },
          };
        },
        commitPreparedOutputDelivery() {
          order.push('commit');
          commitCount += 1;
        },
        getOutputRevision: () => 1,
        exit: new Promise(() => undefined),
        terminate() {},
      },
      closeBridge: () => {},
      taintSession: () => true,
    },
  });

  const failed = await waitForExecuteCodeCell({
    cellRegistry: registry,
    runContext: { threadId },
    request: { cellId: admitted.cellId },
    runningOutputDelivery: {
      persist() {
        order.push('persist-failed');
        throw new Error('simulated durable checkpoint failure');
      },
    },
    signal: undefined,
  });
  assert.equal(failed.ok, false);
  assert.equal(
    failed.ok ? '' : failed.reasonCode,
    'ptc_execute_code_cell_wait_unavailable',
  );
  assert.deepEqual(order, ['prepare', 'persist-failed']);
  assert.equal(commitCount, 0);

  const recovered = await waitForExecuteCodeCell({
    cellRegistry: registry,
    runContext: { threadId },
    request: { cellId: admitted.cellId },
    runningOutputDelivery: {
      persist(delivery) {
        order.push('persisted');
        assert.deepEqual(delivery, {
          cellId: admitted.cellId,
          stdout: 'checkpoint before release\n',
          stderr: '',
          outputReadOffsets: {
            stdoutBytes: 26,
            stderrBytes: 0,
          },
        });
      },
    },
    signal: undefined,
  });
  assert.equal(recovered.ok, true);
  assert.equal(
    recovered.ok && 'stdout' in recovered.value
      ? recovered.value.stdout
      : undefined,
    'checkpoint before release\n',
  );
  assert.deepEqual(order, [
    'prepare',
    'persist-failed',
    'prepare',
    'persisted',
    'commit',
  ]);
  assert.equal(commitCount, 1);
});

void test('execute_code cell registry discards store writes when model code exits nonzero', async () => {
  const threadId = testThreadId(914_1);
  const registry = createPtcExecuteCodeCellRegistry({
    createCellId: () => 'ptc_cell_store_nonzero',
  });
  const admitted = registry.reserveAdmittingCell({ threadId });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) {
    return;
  }
  const finalizationStatuses: string[] = [];
  registry.promoteAdmittedCell({
    threadId,
    cellId: admitted.cellId,
    resources: {
      effectiveTimeoutMs: 60_000,
      handle: makeDetachedHandle({ output: makeDetachedSegment() }),
      closeBridge: () => {},
      taintSession: () => true,
      finalizeStore: async (status) => {
        finalizationStatuses.push(status);
        return { store: { discardedWrites: 1 } };
      },
    },
  });

  assert.deepEqual(
    await registry.recordTerminalCellResult({
      threadId,
      cellId: admitted.cellId,
      result: {
        status: 'completed',
        output: makeDetachedSegment({ stderr: 'model code failed\n' }),
        exit: { kind: 'exit', exitCode: 1, processTerminated: true },
      },
    }),
    { ok: true, value: { bridgeClosed: true } },
  );
  assert.deepEqual(finalizationStatuses, ['terminated']);
  assert.deepEqual(
    registry.takeTerminalCellResult({ threadId, cellId: admitted.cellId }),
    {
      ok: true,
      value: {
        status: 'completed',
        output: makeDetachedSegment({ stderr: 'model code failed\n' }),
        exit: { kind: 'exit', exitCode: 1, processTerminated: true },
        store: { discardedWrites: 1 },
      },
    },
  );
});

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

function makeDetachedSegment(
  args: Partial<DetachedProcessOutputSegment> = {},
): DetachedProcessOutputSegment {
  return {
    stdout: args.stdout ?? '',
    stderr: args.stderr ?? '',
  };
}

function makeDetachedHandle(args: {
  outputRef?: string;
  output: DetachedProcessOutputSegment;
  exit?: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle {
  return {
    ...(args.outputRef === undefined ? {} : { outputRef: args.outputRef }),
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
