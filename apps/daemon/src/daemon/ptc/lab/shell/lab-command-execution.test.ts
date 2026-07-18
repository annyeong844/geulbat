import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from '../profile/lab-profile.js';
import {
  adaptPtcSessionDockerCommandRunner,
  runPtcLabBatchCommandExecution,
  type PtcLabBatchCommandRunner,
  type PtcLabBatchCommandRunnerResult,
  type PtcLabBatchCommandSessionHandle,
} from './lab-command-execution.js';
import type { PtcSessionDockerCommandResult } from '../session/session-docker-contract.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/private';

function admittedLab(args: {
  shellMode: PtcLabPolicyProjection['shell']['mode'];
  maxCommandMs?: number;
  maxProcessCount?: number;
  maxBufferedBytesPerStream?: number;
}): {
  admission: PtcLabAdmittedProfile;
  session: PtcLabBatchCommandSessionHandle;
} {
  const labPolicy: PtcLabPolicyProjection = {
    ...createPtcLabLocalDockerPolicyProjection(),
    policyId: 'ptc_lab_test_batch_policy_v1',
    shell: {
      mode: args.shellMode,
      maxCommandMs: args.maxCommandMs ?? 5000,
      maxProcessCount: args.maxProcessCount ?? 1,
      maxBufferedBytesPerStream: args.maxBufferedBytesPerStream ?? 4096,
    },
  };
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
    session: {
      profile: 'lab',
      labSessionId: 'lab-session-1',
      containerId: 'container-1',
      policyId: labPolicy.policyId,
    },
  };
}

void test('runPtcLabBatchCommandExecution rejects missing or non-lab admission', async () => {
  const safeSubset = admitPtcExecutionProfile({
    requestedProfile: 'default',
    labEnabled: false,
    reason: 'default_policy',
  });
  if (!safeSubset.ok) {
    throw new Error('expected safe subset admission');
  }

  const result = await runPtcLabBatchCommandExecution({
    admission: safeSubset.value,
    session: undefined,
    request: { command: 'echo should-not-run' },
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_admission_required',
  );
});

void test('runPtcLabBatchCommandExecution rejects shell-disabled lab policy', async () => {
  const { admission, session } = admittedLab({ shellMode: 'disabled' });

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'echo should-not-run' },
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_shell_disabled');
});

void test('runPtcLabBatchCommandExecution builds docker exec argv and returns completed exit summary', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const invocations: Parameters<PtcLabBatchCommandRunner>[0][] = [];

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'printf hello', timeoutMs: 1000 },
    now: (() => {
      let value = 10;
      return () => {
        value += 7;
        return value;
      };
    })(),
    runner: async (invocation) => {
      invocations.push(invocation);
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
    result.ok ? result.value.executionClass : '',
    'lab_batch_command',
  );
  assert.equal(result.ok ? result.value.interpreter : '', 'bash');
  assert.equal(result.ok ? result.value.exitCode : -1, 0);
  assert.equal(result.ok ? result.value.stdout : '', 'hello');
  assert.equal(result.ok ? result.value.stderr : 'x', '');
  assert.equal(result.ok ? result.value.effectiveTimeoutMs : 0, 1000);
  assert.equal(result.ok ? result.value.durationMs : 0, 7);

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0]?.args, [
    'exec',
    'container-1',
    '/bin/bash',
    '-lc',
    'printf hello',
  ]);
  assert.equal(invocations[0]?.executable, 'docker');
  assert.equal(invocations[0]?.timeoutMs, 1000);
  assert.equal(invocations[0]?.maxProcessCount, 1);
  assert.equal(invocations[0]?.maxBufferedBytesPerStream, 4096);
});

void test('runPtcLabBatchCommandExecution passes a command beyond the removed 32 KiB policy to the process boundary', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const command = `printf accepted # ${'x'.repeat(40 * 1024)}`;
  const invocations: Parameters<PtcLabBatchCommandRunner>[0][] = [];

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command },
    runner: async (invocation) => {
      invocations.push(invocation);
      return { kind: 'exit', exitCode: 0, stdout: 'accepted', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.stdout : '', 'accepted');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.args[4], command);
});

void test('adaptPtcSessionDockerCommandRunner maps session Docker edge results into batch-command results', async () => {
  const cases: Array<{
    name: string;
    sessionResult: PtcSessionDockerCommandResult;
    expected: PtcLabBatchCommandRunnerResult;
  }> = [
    {
      name: 'interpreter unavailable exit',
      sessionResult: {
        kind: 'exit',
        exitCode: 127,
        stdout: '',
        stderr: '/bin/bash: not found',
      },
      expected: {
        kind: 'interpreter_unavailable',
        stdout: '',
        stderr: '/bin/bash: not found',
      },
    },
    {
      name: 'timeout requires uncertain taint',
      sessionResult: {
        kind: 'timeout',
        stdout: 'partial stdout',
        stderr: 'partial stderr',
      },
      expected: {
        kind: 'timeout',
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        processTerminated: false,
      },
    },
    {
      name: 'timeout can report confirmed child termination',
      sessionResult: {
        kind: 'timeout',
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        processTerminated: true,
      },
      expected: {
        kind: 'timeout',
        stdout: 'partial stdout',
        stderr: 'partial stderr',
        processTerminated: true,
      },
    },
    {
      name: 'cancelled requires uncertain taint',
      sessionResult: {
        kind: 'cancelled',
        stdout: 'cancel stdout',
        stderr: 'cancel stderr',
      },
      expected: {
        kind: 'cancelled',
        stdout: 'cancel stdout',
        stderr: 'cancel stderr',
        processTerminated: false,
      },
    },
    {
      name: 'crash is execution failure',
      sessionResult: {
        kind: 'crash',
        stdout: 'crash stdout',
        stderr: 'crash stderr',
      },
      expected: {
        kind: 'crash',
        stdout: 'crash stdout',
        stderr: 'crash stderr',
      },
    },
  ];

  for (const item of cases) {
    const runner = adaptPtcSessionDockerCommandRunner(async (invocation) => {
      assert.equal(invocation.executable, 'docker');
      assert.deepEqual(invocation.args, ['exec', 'container-1', 'node']);
      assert.equal(invocation.timeoutMs, 1234);
      assert.deepEqual(invocation.outputBufferPolicy, {
        maxBufferedBytesPerStream: 4096,
      });
      return item.sessionResult;
    });

    const result = await runner({
      executable: 'docker',
      args: ['exec', 'container-1', 'node'],
      timeoutMs: 1234,
      maxProcessCount: 1,
      maxBufferedBytesPerStream: 4096,
    });

    assert.deepEqual(result, item.expected, item.name);
  }
});

void test('runPtcLabBatchCommandExecution rejects output that exceeds the lab buffer policy', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const taints: string[] = [];

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'yes' },
    onSessionTainted: async (taint) => {
      taints.push(taint.reasonCode);
    },
    runner: async () => ({
      kind: 'output_limit_exceeded',
      stdout: 'safe-before-limit',
      stderr: '',
      stream: 'stdout',
      maxBufferedBytesPerStream: 4096,
      processTerminated: false,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_command_output_rejected',
  );
  assert.equal(result.ok ? '' : result.diagnostics?.outputStream, 'stdout');
  assert.equal(
    result.ok ? 0 : result.diagnostics?.maxBufferedBytesPerStream,
    4096,
  );
  assert.deepEqual(taints, ['ptc_lab_command_output_rejected']);
});

void test('runPtcLabBatchCommandExecution treats non-zero exit as completed command summary', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  let tainted = false;

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'grep needle missing.txt' },
    onSessionTainted: async () => {
      tainted = true;
    },
    runner: async () => ({
      kind: 'exit',
      exitCode: 1,
      stdout: '',
      stderr: 'not found',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.exitCode : 0, 1);
  assert.equal(result.ok ? result.value.stderr : '', 'not found');
  assert.equal(tainted, false);
});

void test('runPtcLabBatchCommandExecution rejects invalid command and timeout before invoking runner', async () => {
  const { admission, session } = admittedLab({
    shellMode: 'batch_command',
    maxCommandMs: 1000,
  });
  const commands = [
    { command: '' },
    { command: '   ' },
    { command: 'x', timeoutMs: 0 },
    { command: 'x', timeoutMs: 1001 },
    { command: 'x', timeoutMs: Number.POSITIVE_INFINITY },
  ];

  for (const request of commands) {
    const result = await runPtcLabBatchCommandExecution({
      admission,
      session,
      request,
      runner: async () => {
        throw new Error('runner should not be called');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_invalid');
  }
});

void test('runPtcLabBatchCommandExecution rejects policy/session mismatch', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session: { ...session, policyId: 'other-policy' },
    request: { command: 'echo no' },
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_policy_mismatch');
});

void test('runPtcLabBatchCommandExecution maps timeout and uncertain cleanup to taint hook', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const taints: string[] = [];

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'sleep 999' },
    onSessionTainted: async (taint) => {
      taints.push(taint.reasonCode);
    },
    runner: async () => ({
      kind: 'timeout',
      stdout: '',
      stderr: '',
      processTerminated: false,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
  assert.deepEqual(taints, ['ptc_lab_command_timeout']);
});

void test('runPtcLabBatchCommandExecution classifies timeout even when taint hook throws', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'sleep 999' },
    onSessionTainted: async () => {
      throw new Error(PRIVATE_TEST_PATH);
    },
    runner: async () => ({
      kind: 'timeout',
      stdout: '',
      stderr: '',
      processTerminated: false,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
  assert.equal(result.ok ? false : result.diagnostics?.taintHookFailed, true);
  assert.doesNotMatch(JSON.stringify(result), /geulbat-private|\.geulbat/u);
});

void test('runPtcLabBatchCommandExecution maps cancellation and uncertain cleanup to taint hook', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const taints: string[] = [];

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'sleep 999' },
    onSessionTainted: async (taint) => {
      taints.push(taint.reasonCode);
    },
    runner: async () => ({
      kind: 'cancelled',
      stdout: '',
      stderr: '',
      processTerminated: false,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_cancelled');
  assert.deepEqual(taints, ['ptc_lab_command_cancelled']);
});

void test('runPtcLabBatchCommandExecution maps crash to taint hook before execution failure', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const taints: string[] = [];

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'node missing.js' },
    onSessionTainted: async (taint) => {
      taints.push(taint.reasonCode);
    },
    runner: async () => ({
      kind: 'crash',
      stdout: '',
      stderr: 'docker exec failed',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_failed');
  assert.deepEqual(taints, ['ptc_lab_command_failed']);
});

void test('runPtcLabBatchCommandExecution maps interpreter unavailable', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });

  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'echo no' },
    runner: async () => ({
      kind: 'interpreter_unavailable',
      stdout: '',
      stderr: '/bin/bash missing',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_interpreter_unavailable',
  );
});

void test('runPtcLabBatchCommandExecution returns complete sanitized stdout and stderr', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'yes' },
    runner: async () => ({
      kind: 'exit',
      exitCode: 0,
      stdout: 'abcdefghijklmnop',
      stderr: 'qrstuvwxyz',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.stdout : '', 'abcdefghijklmnop');
  assert.equal(result.ok ? result.value.stderr : '', 'qrstuvwxyz');
});

void test('runPtcLabBatchCommandExecution does not return private markers in stdout or stderr', async () => {
  const { admission, session } = admittedLab({ shellMode: 'batch_command' });
  const result = await runPtcLabBatchCommandExecution({
    admission,
    session,
    request: { command: 'echo private' },
    runner: async () => ({
      kind: 'exit',
      exitCode: 0,
      stdout: `${PRIVATE_TEST_PATH} /geulbat/callbacks/epoch-1/callback.sock token=secret access_token=secret`,
      stderr: '/var/run/docker.sock callback.sock provider_secret=secret',
    }),
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /geulbat-private|\.geulbat|docker\.sock|\/geulbat\/callbacks|callback\.sock|token=secret|access_token|provider_secret/u,
  );
  assert.match(result.ok ? result.value.stdout : '', /\[redacted:path\]/u);
  assert.match(
    result.ok ? result.value.stdout : '',
    /\[redacted:callback-path\]/u,
  );
  assert.match(
    result.ok ? result.value.stderr : '',
    /\[redacted:docker-socket\]/u,
  );
  assert.match(
    result.ok ? result.value.stderr : '',
    /\[redacted:callback-socket\]/u,
  );
  assert.match(result.ok ? result.value.stdout : '', /\[redacted:secret\]/u);
  assert.match(result.ok ? result.value.stderr : '', /\[redacted:secret\]/u);
});
