import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deferredDetachedProcessExit as deferredExit,
  makeDetachedHandle,
  makeDetachedSegment,
} from '../../../../test-support/ptc-execute-code-cell-process.js';
import {
  makeTestPtcExecuteCodeCellConfig as makeTestCellConfig,
  TEST_PTC_EXECUTE_CODE_CALLBACK_TRANSPORT_POLICY as TEST_CALLBACK_TRANSPORT_POLICY,
} from '../../../../test-support/ptc-execute-code-runtime-cell.js';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { createPtcExecuteCodeCellRegistry } from './execute-code-cell-registry.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';

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

void test('createPtcExecuteCodeRuntime fails closed when durable cell coordinates cannot be armed', async (t) => {
  await t.test('process output coordinate is missing', async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-cell-missing-process-coordinate-workspace-'),
    );
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-cell-missing-process-coordinate-runtime-'),
    );
    const fixture = createPtcSessionDockerCommandFixture({
      policy: createPtcSessionDockerLocalBatchCommandPolicy(),
      containerId: 'container-agent-ptc-cell-missing-process-coordinate',
    });
    const runtime = createPtcExecuteCodeRuntime({
      commandRunner: fixture.runner,
      startCellProcess: () => ({
        ok: true,
        handle: makeDetachedHandle({
          output: makeDetachedSegment({ stdout: 'must not escape\n' }),
        }),
      }),
      ptcCell: makeTestCellConfig(60_000),
      runtimeRootForState: () => runtimeRoot,
    });
    runtime.attachCellCoordinateStore?.({
      listPtcExecuteCodeCellCoordinates: () => [],
      persistPtcExecuteCodeCellCoordinate() {
        assert.fail('a missing process coordinate must not be persisted');
      },
      deletePtcExecuteCodeCellCoordinate() {},
    });

    try {
      const result = await runtime.executeCode({
        runContext: makeRunContext({
          threadId: testThreadId(932_1),
          stateRoot,
        }),
        request: { code: 'await background_work' },
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_execute_code_session_cleanup_failed',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        processOutputRefMissing: true,
      });
    } finally {
      await runtime.closeAll();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  await t.test('callback output coordinate is missing', async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-cell-missing-callback-coordinate-workspace-'),
    );
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-cell-missing-callback-coordinate-runtime-'),
    );
    const fixture = createPtcSessionDockerCommandFixture({
      policy: createPtcSessionDockerLocalBatchCommandPolicy(),
      containerId: 'container-agent-ptc-cell-missing-callback-coordinate',
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
            epochId: 'epoch-missing-callback-coordinate',
            token: 'token-missing-callback-coordinate',
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
          outputRef: 'command-output:ptc/missing-callback-coordinate',
          output: makeDetachedSegment(),
        }),
      }),
      ptcCell: makeTestCellConfig(60_000),
      runtimeRootForState: () => runtimeRoot,
    });
    runtime.attachCellCoordinateStore?.({
      listPtcExecuteCodeCellCoordinates: () => [],
      persistPtcExecuteCodeCellCoordinate() {
        assert.fail('an incomplete callback coordinate must not be persisted');
      },
      deletePtcExecuteCodeCellCoordinate() {},
    });

    try {
      const result = await runtime.executeCode({
        runContext: makeRunContext({
          threadId: testThreadId(932_2),
          stateRoot,
        }),
        request: { code: 'await background_work' },
        toolCallbackHandler: async () => ({
          ok: true,
          result: { ok: true, output: '' },
        }),
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_execute_code_session_cleanup_failed',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        callbackOutputRefMissing: true,
      });
    } finally {
      await runtime.closeAll();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  await t.test(
    'coordinate persistence and compensating deletion fail',
    async () => {
      const stateRoot = await mkdtemp(
        join(
          tmpdir(),
          'geulbat-ptc-cell-coordinate-persist-failure-workspace-',
        ),
      );
      const runtimeRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-ptc-cell-coordinate-persist-failure-runtime-'),
      );
      const fixture = createPtcSessionDockerCommandFixture({
        policy: createPtcSessionDockerLocalBatchCommandPolicy(),
        containerId: 'container-agent-ptc-cell-coordinate-persist-failure',
      });
      const runtime = createPtcExecuteCodeRuntime({
        commandRunner: fixture.runner,
        startCellProcess: () => ({
          ok: true,
          handle: makeDetachedHandle({
            outputRef: 'command-output:ptc/coordinate-persist-failure',
            output: makeDetachedSegment(),
          }),
        }),
        ptcCell: makeTestCellConfig(60_000),
        runtimeRootForState: () => runtimeRoot,
      });
      runtime.attachCellCoordinateStore?.({
        listPtcExecuteCodeCellCoordinates: () => [],
        persistPtcExecuteCodeCellCoordinate() {
          throw new Error('coordinate persistence unavailable');
        },
        deletePtcExecuteCodeCellCoordinate() {
          throw new Error('coordinate deletion unavailable');
        },
      });

      try {
        const result = await runtime.executeCode({
          runContext: makeRunContext({
            threadId: testThreadId(932_3),
            stateRoot,
          }),
          request: { code: 'await background_work' },
        });

        assert.equal(result.ok, false);
        assert.equal(
          result.ok ? '' : result.reasonCode,
          'ptc_execute_code_session_cleanup_failed',
        );
        assert.deepEqual(result.ok ? undefined : result.diagnostics, {
          cellCoordinatePersistFailed: true,
          cellCoordinateDeleteFailed: true,
        });
      } finally {
        await runtime.closeAll();
        await rm(stateRoot, { recursive: true, force: true });
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    },
  );
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
