import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { PTC_EXECUTE_CODE_TOOL_NAME } from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcExecuteCodeStore } from './execute-code-store.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM } from '../../lab/profile/lab-profile-contract.js';
import type { ExecuteCodeCellProcessInvocation } from './execute-code-cell-process.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/ptc/private-token';

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
