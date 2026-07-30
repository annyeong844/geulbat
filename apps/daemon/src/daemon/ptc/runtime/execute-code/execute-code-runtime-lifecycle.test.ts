import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPtcSessionDockerCommandFixture,
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
} from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/ptc/private-token';
const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

void test('createPtcExecuteCodeRuntime delegates restart residue cleanup without starting a session', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-restart-cleanup-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-restart-cleanup-runtime-'),
  );
  let reapCount = 0;
  let closeAllCount = 0;
  const sessionManager: PtcSessionDockerManager = {
    async reapRestartResidue() {
      reapCount += 1;
      return { ok: true, value: undefined };
    },
    async getOrCreate() {
      throw new Error('restart cleanup must not start a session');
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      closeAllCount += 1;
      return { ok: true, value: undefined };
    },
  };
  const runtime = createPtcExecuteCodeRuntime({
    createSessionManager: () => sessionManager,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    assert.deepEqual(await runtime.reapRestartResidue?.({ stateRoot }), {
      ok: true,
    });
    assert.equal(reapCount, 1);
  } finally {
    await runtime.closeAll();
    assert.equal(closeAllCount, 1);
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reports unavailable and failed restart cleanup', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-restart-cleanup-failures-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-restart-cleanup-failures-runtime-'),
  );
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  const baseManager = {
    async getOrCreate() {
      throw new Error('restart cleanup must not start a session');
    },
    async close() {
      return { ok: true, value: undefined } as const;
    },
    async closeAll() {
      return { ok: true, value: undefined } as const;
    },
  };

  await t.test('manager has no restart cleanup capability', async () => {
    const sessionManager: PtcSessionDockerManager = baseManager;
    const runtime = createPtcExecuteCodeRuntime({
      createSessionManager: () => sessionManager,
      runtimeRootForState: () => runtimeRoot,
    });
    try {
      assert.deepEqual(await runtime.reapRestartResidue?.({ stateRoot }), {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC execute_code restart cleanup is unavailable',
      });
    } finally {
      await runtime.closeAll();
    }
  });

  await t.test('manager reports restart residue sweep failure', async () => {
    const sessionManager: PtcSessionDockerManager = {
      ...baseManager,
      async reapRestartResidue() {
        return {
          ok: false,
          reasonCode: 'restart_residue_sweep_failed',
          message: 'residue remains',
        };
      },
    };
    const runtime = createPtcExecuteCodeRuntime({
      createSessionManager: () => sessionManager,
      runtimeRootForState: () => runtimeRoot,
    });
    try {
      assert.deepEqual(await runtime.reapRestartResidue?.({ stateRoot }), {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC execute_code restart cleanup failed',
        diagnostics: {
          cleanupReasonCode: 'restart_residue_sweep_failed',
        },
      });
    } finally {
      await runtime.closeAll();
    }
  });
});

void test('createPtcExecuteCodeRuntime reuses a clean session until explicit runtime cleanup', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-reuse-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-reuse-runtime-'),
  );
  let execCount = 0;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-reuse',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        execCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `run ${execCount}\n`,
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });
  const runContext = makeRunContext({
    threadId: testThreadId(905),
    stateRoot,
  });

  try {
    const first = await runtime.executeCode({
      runContext,
      request: { code: 'console.log("first")' },
    });
    const second = await runtime.executeCode({
      runContext,
      request: { code: 'console.log("second")' },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }
    assert.equal(first.value.stdout, 'run 1\n');
    assert.equal(second.value.stdout, 'run 2\n');
    assert.deepEqual(first.value.sessionLifecycle, {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    });
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      1,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'start')
        .length,
      1,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      2,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
        .length,
      0,
    );

    const cleanup = await runtime.closeAll();
    assert.equal(cleanup.ok, true);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-reuse']],
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime preserves callback bridge session diagnostics', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-bridge-diagnostics-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-bridge-diagnostics-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-bridge-diagnostics',
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async () => ({
      ok: false,
      reasonCode: 'session_unavailable',
      message: 'PTC session container is unavailable',
      diagnostics: { sessionReasonCode: 'docker_unavailable' },
    }),
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(950),
        stateRoot,
      }),
      request: { code: 'console.log("bridge diagnostics")' },
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
      bridgeReasonCode: 'session_unavailable',
    });
    assert.equal(fixture.invocations.length, 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime clears state runtime tracking after closeAll failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-closeall-failure-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-closeall-failure-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-closeall-failure',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'closeAll failure setup\n',
          stderr: '',
        };
      }
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
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(909),
        stateRoot,
      }),
      request: { code: 'console.log("closeAll failure setup")' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await runtime.closeAll(), {
      ok: false,
      reasonCode: 'ptc_execute_code_session_cleanup_failed',
      message: 'PTC execute_code session cleanup failed',
      diagnostics: {
        cleanupReasonCode: 'container_remove_failed',
        stateRuntimeCount: 1,
      },
    });
    assert.deepEqual(await runtime.closeAll(), { ok: true });
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
        .length,
      1,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keys state runtimes by canonical state root realpath', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-workspace-'),
  );
  const stateRootAlias = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-alias-parent-'),
  );
  const stateRootAliasPath = join(stateRootAlias, 'state-root-link');
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-runtime-'),
  );
  await symlink(stateRoot, stateRootAliasPath, 'dir');
  const canonicalStateRoot = await realpath(stateRoot);
  const runtimeRootInputs: string[] = [];
  let execCount = 0;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-realpath',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        execCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `realpath run ${execCount}\n`,
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    runtimeRootForState: (stateRootInput) => {
      runtimeRootInputs.push(stateRootInput);
      assert.equal(stateRootInput, canonicalStateRoot);
      return runtimeRoot;
    },
  });

  try {
    const first = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(907),
        stateRoot,
      }),
      request: { code: 'console.log("canonical")' },
    });
    const second = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(907),
        stateRoot: stateRootAliasPath,
      }),
      request: { code: 'console.log("alias")' },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }
    assert.equal(first.value.stdout, 'realpath run 1\n');
    assert.equal(second.value.stdout, 'realpath run 2\n');
    assert.deepEqual(runtimeRootInputs, [canonicalStateRoot]);
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      1,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      2,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRootAlias, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes tainted session on timeout without leaking command output paths', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-timeout-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-timeout-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'timeout',
          stdout: `stdout at ${PRIVATE_TEST_PATH}`,
          stderr: `stderr at ${PRIVATE_TEST_PATH}`,
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(903),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 10 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
    assert.doesNotMatch(
      JSON.stringify(result),
      /geulbat-private|\.geulbat|private-token/u,
    );
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', PTC_TEST_SESSION_DOCKER_CONTAINER_ID]],
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
