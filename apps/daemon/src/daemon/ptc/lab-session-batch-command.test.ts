import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from './lab-profile.js';
import type { PtcLabBatchCommandRunner } from './lab-command-execution.js';
import { createPtcLabSessionBatchCommandRunner } from './lab-session-batch-command.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  normalizePtcSessionDockerReuseKey,
  type PtcSessionDockerHandle,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerResult,
  type PtcSessionDockerReuseKey,
} from './session-docker.js';

const PRIVATE_TEST_PATH = ['', 'home', 'user', '.geulbat', 'private'].join(
  '/',
);

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-lab-command',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

const REUSE_KEY: PtcSessionDockerReuseKey = Object.freeze(
  normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
  }),
);

function admittedLab(): PtcLabAdmittedProfile {
  const labPolicy: PtcLabPolicyProjection = {
    ...createPtcLabLocalDockerPolicyProjection(),
    policyId: 'ptc_lab_test_session_command_policy_v1',
    shell: {
      mode: 'batch_command',
      maxCommandMs: 5000,
      maxProcessCount: 1,
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
  return admission.value;
}

function readyHandle(
  args: {
    containerId?: string;
    reuseKey?: PtcSessionDockerReuseKey;
  } = {},
): PtcSessionDockerHandle {
  const reuseKey = args.reuseKey ?? REUSE_KEY;
  return {
    state: 'ready',
    containerId: args.containerId ?? 'container-session-1',
    reuseKey,
    callbackRootHostPath: '/tmp/geulbat-ptc-test/callbacks',
    callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
    artifactRootHostPath: '/tmp/geulbat-ptc-test/artifacts',
    artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
    packageCacheRootHostPath: '/tmp/geulbat-ptc-test/package-cache',
    packageCacheRootContainerPath: reuseKey.packageCacheRootContainerPath,
    packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
    packageCacheId: reuseKey.packageCacheId,
    packageCacheIdentityHash: reuseKey.packageCacheIdentityHash,
  };
}

function fakeManager(
  args: {
    handle?: PtcSessionDockerHandle;
    getOrCreate?: (
      identity: PtcSessionDockerIdentity,
      options?: { signal?: AbortSignal },
    ) => Promise<PtcSessionDockerResult<PtcSessionDockerHandle>>;
    close?: (
      identity: PtcSessionDockerIdentity,
      options?: { signal?: AbortSignal },
    ) => Promise<PtcSessionDockerResult<void>>;
  } = {},
): {
  manager: PtcSessionDockerManager;
  getOrCreateCalls: Array<{
    identity: PtcSessionDockerIdentity;
    signal?: AbortSignal;
  }>;
  closeCalls: Array<{
    identity: PtcSessionDockerIdentity;
    signal?: AbortSignal;
  }>;
} {
  const getOrCreateCalls: Array<{
    identity: PtcSessionDockerIdentity;
    signal?: AbortSignal;
  }> = [];
  const closeCalls: Array<{
    identity: PtcSessionDockerIdentity;
    signal?: AbortSignal;
  }> = [];
  const manager: PtcSessionDockerManager = {
    getOrCreate: async (identity, options) => {
      getOrCreateCalls.push(
        options?.signal === undefined
          ? { identity }
          : { identity, signal: options.signal },
      );
      if (args.getOrCreate) {
        return await args.getOrCreate(identity, options);
      }
      return { ok: true, value: args.handle ?? readyHandle() };
    },
    close: async (identity, options) => {
      closeCalls.push(
        options?.signal === undefined
          ? { identity }
          : { identity, signal: options.signal },
      );
      if (args.close) {
        return await args.close(identity, options);
      }
      return { ok: true, value: undefined };
    },
    closeAll: async () => ({ ok: true, value: undefined }),
  };
  return { manager, getOrCreateCalls, closeCalls };
}

void test('runPtcLabSessionBatchCommand gets a real session handle and runs one command', async () => {
  const { manager, getOrCreateCalls, closeCalls } = fakeManager();
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });
  const invocations: Parameters<PtcLabBatchCommandRunner>[0][] = [];

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
    identity: IDENTITY,
    request: { command: 'printf hello', timeoutMs: 1000 },
    runner: async (invocation: Parameters<PtcLabBatchCommandRunner>[0]) => {
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
    result.ok ? result.value.containerId : '',
    'container-session-1',
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
  assert.equal(getOrCreateCalls.length, 1);
  assert.deepEqual(getOrCreateCalls[0]?.identity, IDENTITY);
  assert.equal(closeCalls.length, 0);
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0]?.args, [
    'exec',
    'container-session-1',
    '/bin/bash',
    '-lc',
    'printf hello',
  ]);
});

void test('runPtcLabSessionBatchCommand forwards AbortSignal to acquisition and command execution', async () => {
  const { manager, getOrCreateCalls } = fakeManager();
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });
  const controller = new AbortController();
  let commandSignal: AbortSignal | undefined;

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
    identity: IDENTITY,
    request: { command: 'printf hello' },
    signal: controller.signal,
    runner: async (invocation: Parameters<PtcLabBatchCommandRunner>[0]) => {
      commandSignal = invocation.signal;
      return { kind: 'exit', exitCode: 0, stdout: 'hello', stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(getOrCreateCalls[0]?.signal, controller.signal);
  assert.equal(commandSignal, controller.signal);
});

void test('runPtcLabSessionBatchCommand maps session acquisition failure without leaking diagnostics', async () => {
  const { manager } = fakeManager({
    getOrCreate: async () => ({
      ok: false,
      reasonCode: 'container_create_failed',
      message: `failed at ${PRIVATE_TEST_PATH}`,
      diagnostics: { stderr: PRIVATE_TEST_PATH },
    }),
  });
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
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
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});

void test('runPtcLabSessionBatchCommand maps thrown session acquisition without leaking errors', async () => {
  const { manager } = fakeManager({
    getOrCreate: async () => {
      throw new Error(PRIVATE_TEST_PATH);
    },
  });
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
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
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});

void test('runPtcLabSessionBatchCommand classifies unexpected command-owner throws', async () => {
  const { manager, closeCalls } = fakeManager();
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
    commandExecutor: async () => {
      throw new Error(PRIVATE_TEST_PATH);
    },
  });

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
    identity: IDENTITY,
    request: { command: 'printf no' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_failed');
  assert.equal(closeCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});

void test('runPtcLabSessionBatchCommand closes tainted session without reusing caller aborted signal', async () => {
  const { manager, closeCalls } = fakeManager();
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });
  const controller = new AbortController();
  controller.abort();

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
    identity: IDENTITY,
    request: { command: 'sleep 999' },
    signal: controller.signal,
    runner: async () => ({
      kind: 'timeout',
      stdout: '',
      stderr: '',
      processTerminated: false,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0]?.identity, IDENTITY);
  assert.equal(closeCalls[0]?.signal, undefined);
});

void test('runPtcLabSessionBatchCommand preserves timeout reason when taint close fails', async () => {
  const { manager } = fakeManager({
    close: async () => ({
      ok: false,
      reasonCode: 'container_remove_failed',
      message: `rm failed at ${PRIVATE_TEST_PATH}`,
      diagnostics: { stderr: PRIVATE_TEST_PATH },
    }),
  });
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
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
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
  assert.deepEqual(result.ok ? undefined : result.diagnostics, {
    sessionCloseFailed: true,
    sessionReasonCode: 'container_remove_failed',
  });
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});

void test('runPtcLabSessionBatchCommand preserves cancellation reason when taint close throws', async () => {
  const { manager } = fakeManager({
    close: async () => {
      throw new Error(PRIVATE_TEST_PATH);
    },
  });
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });

  const result = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
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
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_cancelled');
  assert.deepEqual(result.ok ? undefined : result.diagnostics, {
    sessionCloseFailed: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat|private/u);
});

void test('runPtcLabSessionBatchCommand rejects concurrent commands for the same resolved session', async () => {
  const { manager, closeCalls } = fakeManager();
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
    admission: admittedLab(),
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
    admission: admittedLab(),
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
  assert.equal(closeCalls.length, 0);
});

void test('runPtcLabSessionBatchCommand releases busy key after failure', async () => {
  const { manager } = fakeManager();
  const owner = createPtcLabSessionBatchCommandRunner({
    sessionManager: manager,
  });

  const failed = await owner.runPtcLabSessionBatchCommand({
    admission: admittedLab(),
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
    admission: admittedLab(),
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
