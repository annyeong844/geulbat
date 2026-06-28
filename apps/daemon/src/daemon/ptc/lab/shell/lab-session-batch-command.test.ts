import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  withRealPtcSessionDockerManager,
  type PtcSessionDockerManagerFixture,
} from '../../../../test-support/ptc-session-docker.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerBatchCommandPolicyProjection,
  type PtcLabAdmittedProfile,
} from '../profile/lab-profile.js';
import type { PtcLabBatchCommandRunner } from './lab-command-execution.js';
import { createPtcLabSessionBatchCommandRunner } from './lab-session-batch-command.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../session/session-docker-contract.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
  PtcSessionDockerPolicy,
} from '../session/session-docker-contract.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/private';

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-lab-command',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

void test('lab session batch command uses the shared tainted-session close owner', async () => {
  const sourceUrl = ptcSourceUrl('lab/shell/lab-session-batch-command.ts');
  const graph = await collectPtcStaticImportGraph(sourceUrl);
  const directSpecifiers = readPtcStaticImportSpecifiers(graph, sourceUrl);

  assert.equal(
    directSpecifiers.includes('../session/session-taint-close.js'),
    true,
  );
});

function admittedLab(): {
  admission: PtcLabAdmittedProfile;
  dockerPolicy: PtcSessionDockerPolicy;
} {
  const labPolicy = createPtcLabLocalDockerBatchCommandPolicyProjection();
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  if (!admission.ok) {
    throw new Error('expected admitted lab profile');
  }
  return {
    admission: admission.value,
    dockerPolicy: createPtcSessionDockerLocalBatchCommandPolicy(),
  };
}

async function withSessionManager<T>(
  args: {
    policy: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    commandResult?: (
      invocation: PtcSessionDockerCommandInvocation,
    ) =>
      | PtcSessionDockerCommandResult
      | undefined
      | Promise<PtcSessionDockerCommandResult | undefined>;
    realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withRealPtcSessionDockerManager(
    {
      identity: IDENTITY,
      containerId: PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
      ...args,
    },
    fn,
  );
}

void test('runPtcLabSessionBatchCommand gets a real session handle and runs one command', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager({ policy: dockerPolicy }, async ({ manager }) => {
    const owner = createPtcLabSessionBatchCommandRunner({
      sessionManager: manager,
    });
    const commandInvocations: Parameters<PtcLabBatchCommandRunner>[0][] = [];

    const result = await owner.runPtcLabSessionBatchCommand({
      admission,
      identity: IDENTITY,
      request: { command: 'printf hello', timeoutMs: 1000 },
      runner: async (invocation: Parameters<PtcLabBatchCommandRunner>[0]) => {
        commandInvocations.push(invocation);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'hello',
          stderr: '',
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.value.containerId : '',
      PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
    );
    assert.match(
      result.ok ? result.value.labSessionId : '',
      /^ptc-lab-[a-f0-9]{32}$/u,
    );
    assert.equal(result.ok ? result.value.stdout : '', 'hello');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('artifactRootHostPath'), false);
    assert.equal(serialized.includes('artifactRootContainerPath'), false);
    assert.equal(serialized.includes('/geulbat/artifacts'), false);
    assert.equal(serialized.includes('/tmp/geulbat-ptc-test/artifacts'), false);
    assert.equal(commandInvocations.length, 1);
    assert.deepEqual(commandInvocations[0]?.args, [
      'exec',
      PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
      '/bin/bash',
      '-lc',
      'printf hello',
    ]);
  });
});

void test('runPtcLabSessionBatchCommand forwards AbortSignal to acquisition and command execution', async () => {
  const { admission, dockerPolicy } = admittedLab();
  const controller = new AbortController();

  await withSessionManager(
    { policy: dockerPolicy },
    async ({ manager, invocations }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });
      let commandSignal: AbortSignal | undefined;

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'printf hello' },
        signal: controller.signal,
        runner: async (invocation: Parameters<PtcLabBatchCommandRunner>[0]) => {
          commandSignal = invocation.signal;
          return { kind: 'exit', exitCode: 0, stdout: 'hello', stderr: '' };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(commandSignal, controller.signal);
      assert.equal(
        invocations.every(
          (invocation) => invocation.signal === controller.signal,
        ),
        true,
      );
    },
  );
});

void test('runPtcLabSessionBatchCommand maps session acquisition failure without leaking diagnostics', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager(
    {
      policy: dockerPolicy,
      createResult: {
        kind: 'exit',
        exitCode: 1,
        stdout: '',
        stderr: `failed at ${PRIVATE_TEST_PATH}`,
      },
    },
    async ({ manager, invocations }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'printf no' },
        runner: async () => {
          throw new Error('runner should not be called');
        },
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_session_unavailable',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        sessionReasonCode: 'container_create_failed',
      });
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'exec'),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|private/u,
      );
    },
  );
});

void test('runPtcLabSessionBatchCommand maps thrown session acquisition without leaking errors', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager(
    {
      policy: dockerPolicy,
      realpathWorkspaceRoot: async () => {
        throw new Error(PRIVATE_TEST_PATH);
      },
    },
    async ({ manager, invocations }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'printf no' },
        runner: async () => {
          throw new Error('runner should not be called');
        },
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_session_unavailable',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        sessionReasonCode: 'session_manager_threw',
      });
      assert.deepEqual(invocations, []);
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|private/u,
      );
    },
  );
});

void test('runPtcLabSessionBatchCommand classifies unexpected command-owner throws', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager(
    { policy: dockerPolicy },
    async ({ manager, invocations }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
        commandExecutor: async () => {
          throw new Error(PRIVATE_TEST_PATH);
        },
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'printf no' },
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_command_failed',
      );
      assert.equal(
        invocations.some((invocation) => invocation.args[0] === 'rm'),
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|private/u,
      );
    },
  );
});

void test('runPtcLabSessionBatchCommand closes tainted session without reusing caller aborted signal', async () => {
  const { admission, dockerPolicy } = admittedLab();
  const controller = new AbortController();

  await withSessionManager(
    { policy: dockerPolicy },
    async ({ manager, invocations }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'sleep 999' },
        signal: controller.signal,
        runner: async () => {
          controller.abort();
          return {
            kind: 'timeout',
            stdout: '',
            stderr: '',
            processTerminated: false,
          };
        },
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_command_timeout',
      );
      const removeInvocation = invocations.find(
        (invocation) => invocation.args[0] === 'rm',
      );
      assert.ok(removeInvocation);
      assert.equal(removeInvocation.signal, undefined);
    },
  );
});

void test('runPtcLabSessionBatchCommand closes tainted session after command crash', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager(
    { policy: dockerPolicy },
    async ({ manager, invocations }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'node missing.js' },
        runner: async () => ({
          kind: 'crash',
          stdout: '',
          stderr: '',
        }),
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_command_failed',
      );
      assert.ok(invocations.some((invocation) => invocation.args[0] === 'rm'));
    },
  );
});

void test('runPtcLabSessionBatchCommand preserves timeout reason when taint close fails', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager(
    {
      policy: dockerPolicy,
      commandResult: (invocation) =>
        invocation.args[0] === 'rm'
          ? {
              kind: 'exit',
              exitCode: 1,
              stdout: '',
              stderr: `rm failed at ${PRIVATE_TEST_PATH}`,
            }
          : undefined,
    },
    async ({ manager }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'sleep 999' },
        runner: async () => ({
          kind: 'timeout',
          stdout: '',
          stderr: '',
          processTerminated: false,
        }),
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_command_timeout',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        sessionCloseFailed: true,
        sessionReasonCode: 'container_remove_failed',
        sessionTainted: true,
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|private/u,
      );
    },
  );
});

void test('runPtcLabSessionBatchCommand preserves cancellation reason when taint close throws', async () => {
  const { admission, dockerPolicy } = admittedLab();
  let realpathCalls = 0;

  await withSessionManager(
    {
      policy: dockerPolicy,
      realpathWorkspaceRoot: async () => {
        realpathCalls += 1;
        if (realpathCalls > 1) {
          throw new Error(PRIVATE_TEST_PATH);
        }
        return '/real/workspace/project-a';
      },
    },
    async ({ manager }) => {
      const owner = createPtcLabSessionBatchCommandRunner({
        sessionManager: manager,
      });

      const result = await owner.runPtcLabSessionBatchCommand({
        admission,
        identity: IDENTITY,
        request: { command: 'sleep 999' },
        runner: async () => ({
          kind: 'cancelled',
          stdout: '',
          stderr: '',
          processTerminated: false,
        }),
      });

      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reasonCode,
        'ptc_lab_command_cancelled',
      );
      assert.deepEqual(result.ok ? undefined : result.diagnostics, {
        sessionCloseFailed: true,
        sessionTainted: true,
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /geulbat-private|\.geulbat|private/u,
      );
    },
  );
});

void test('runPtcLabSessionBatchCommand rejects concurrent commands for the same resolved session', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager({ policy: dockerPolicy }, async ({ manager }) => {
    const owner = createPtcLabSessionBatchCommandRunner({
      sessionManager: manager,
    });
    let releaseFirst!: () => void;
    const firstCommandCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCommandStarted!: () => void;
    const firstCommandDidStart = new Promise<void>((resolve) => {
      firstCommandStarted = resolve;
    });

    const first = owner.runPtcLabSessionBatchCommand({
      admission,
      identity: IDENTITY,
      request: { command: 'sleep 1' },
      runner: async () => {
        firstCommandStarted();
        await firstCommandCanFinish;
        return { kind: 'exit', exitCode: 0, stdout: 'first', stderr: '' };
      },
    });

    await firstCommandDidStart;

    const second = await owner.runPtcLabSessionBatchCommand({
      admission,
      identity: IDENTITY,
      request: { command: 'printf second' },
      runner: async () => {
        throw new Error('second command should not run while first is active');
      },
    });

    releaseFirst();
    const firstResult = await first;

    assert.equal(second.ok, false);
    assert.equal(second.ok ? '' : second.reasonCode, 'ptc_lab_session_busy');
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.ok ? firstResult.value.stdout : '', 'first');
  });
});

void test('runPtcLabSessionBatchCommand releases busy key after failure', async () => {
  const { admission, dockerPolicy } = admittedLab();

  await withSessionManager({ policy: dockerPolicy }, async ({ manager }) => {
    const owner = createPtcLabSessionBatchCommandRunner({
      sessionManager: manager,
    });

    const failed = await owner.runPtcLabSessionBatchCommand({
      admission,
      identity: IDENTITY,
      request: { command: 'sleep 999' },
      runner: async () => ({
        kind: 'timeout',
        stdout: '',
        stderr: '',
        processTerminated: true,
      }),
    });

    const next = await owner.runPtcLabSessionBatchCommand({
      admission,
      identity: IDENTITY,
      request: { command: 'printf next' },
      runner: async () => ({
        kind: 'exit',
        exitCode: 0,
        stdout: 'next',
        stderr: '',
      }),
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.ok ? '' : failed.reasonCode, 'ptc_lab_command_timeout');
    assert.equal(next.ok, true);
    assert.equal(next.ok ? next.value.stdout : '', 'next');
  });
});
