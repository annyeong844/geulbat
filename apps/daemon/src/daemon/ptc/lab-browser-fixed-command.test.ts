import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runPtcLabBrowserFixedCommandAttempt } from './lab-browser-fixed-command.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from './lab-package-cache-contract.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  type PtcSessionDockerHandle,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
} from './session-docker-contract.js';

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-browser-fixed-command',
  trustContextId: 'trust-local-v1',
  workspaceRoot: '/workspace/project-a',
});

void test('fixed browser command owner stays below feature-specific browser result owners', async () => {
  const source = await readFile(
    new URL(
      '../../../src/daemon/ptc/lab-browser-fixed-command.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.match(source, /session-docker-contract\.js/u);
  assert.match(source, /session-docker-command\.js/u);
  assert.doesNotMatch(
    source,
    /lab-browser-(?:owner|navigation|runtime)(?:-[a-z]+)?\.js/u,
  );
  assert.doesNotMatch(source, /browser(?:Owner|Navigation|Runtime)Failure/u);
});

void test('runPtcLabBrowserFixedCommandAttempt executes daemon script after session validation', async () => {
  const handle = createHandle();
  let validationCalled = false;
  const outcome = await runPtcLabBrowserFixedCommandAttempt({
    commandRunner: async (invocation) => {
      assert.equal(invocation.executable, '/usr/bin/docker');
      assert.equal(invocation.timeoutMs, 1_000);
      assert.equal(invocation.args[0], 'exec');
      assert.equal(invocation.args[1], handle.containerId);
      assert.equal(invocation.args[2], 'node');
      assert.equal(invocation.args[3], '-e');
      assert.equal(invocation.args[4], 'globalThis.__FIXED_BROWSER__ = true;');
      return { kind: 'exit', exitCode: 0, stdout: '{}\n', stderr: '' };
    },
    dockerPath: '/usr/bin/docker',
    identity: IDENTITY,
    now: (() => {
      let value = 10;
      return () => {
        value += 11;
        return value;
      };
    })(),
    runnerThrew: () => ({ ok: false as const, reasonCode: 'runner_threw' }),
    runtimeScript: 'globalThis.__FIXED_BROWSER__ = true;',
    sessionManager: createSessionManager({ handle }),
    sessionUnavailable: (reasonCode) => ({ ok: false as const, reasonCode }),
    timeoutMs: 1_000,
    validateSession: (sessionHandle) => {
      validationCalled = true;
      assert.equal(sessionHandle, handle);
      return { ok: true };
    },
  });

  assert.equal(validationCalled, true);
  assert.deepEqual(outcome, {
    ok: true,
    durationMs: 11,
    execution: { kind: 'exit', exitCode: 0, stdout: '{}\n', stderr: '' },
    handle,
  });
});

void test('runPtcLabBrowserFixedCommandAttempt stops on session acquisition failure before validation or command execution', async () => {
  let validationCalled = false;
  let commandCalled = false;
  const outcome = await runPtcLabBrowserFixedCommandAttempt({
    commandRunner: async () => {
      commandCalled = true;
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
    },
    identity: IDENTITY,
    runnerThrew: () => ({ ok: false as const, reasonCode: 'runner_threw' }),
    runtimeScript: 'globalThis.__FIXED_BROWSER__ = true;',
    sessionManager: createSessionManager({
      reasonCode: 'container_create_failed',
    }),
    sessionUnavailable: (reasonCode) => ({ ok: false as const, reasonCode }),
    timeoutMs: 1_000,
    validateSession: () => {
      validationCalled = true;
      return { ok: true };
    },
  });

  assert.deepEqual(outcome, {
    ok: false,
    failure: { ok: false, reasonCode: 'container_create_failed' },
  });
  assert.equal(validationCalled, false);
  assert.equal(commandCalled, false);
});

void test('runPtcLabBrowserFixedCommandAttempt stops on session validation failure before command execution', async () => {
  let commandCalled = false;
  const outcome = await runPtcLabBrowserFixedCommandAttempt({
    commandRunner: async () => {
      commandCalled = true;
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
    },
    identity: IDENTITY,
    runnerThrew: () => ({ ok: false as const, reasonCode: 'runner_threw' }),
    runtimeScript: 'globalThis.__FIXED_BROWSER__ = true;',
    sessionManager: createSessionManager({ handle: createHandle() }),
    sessionUnavailable: (reasonCode) => ({ ok: false as const, reasonCode }),
    timeoutMs: 1_000,
    validateSession: () => ({
      ok: false,
      failure: { ok: false as const, reasonCode: 'policy_mismatch' },
    }),
  });

  assert.deepEqual(outcome, {
    ok: false,
    failure: { ok: false, reasonCode: 'policy_mismatch' },
  });
  assert.equal(commandCalled, false);
});

void test('runPtcLabBrowserFixedCommandAttempt maps runner throw without leaking raw exception material', async () => {
  const outcome = await runPtcLabBrowserFixedCommandAttempt({
    commandRunner: async () => {
      throw new Error('/tmp/geulbat-private/.geulbat/secret should not leak');
    },
    identity: IDENTITY,
    runnerThrew: () => ({
      ok: false as const,
      reasonCode: 'ptc_lab_browser_execution_failed',
    }),
    runtimeScript: 'globalThis.__FIXED_BROWSER__ = true;',
    sessionManager: createSessionManager({ handle: createHandle() }),
    sessionUnavailable: (reasonCode) => ({ ok: false as const, reasonCode }),
    timeoutMs: 1_000,
    validateSession: () => ({ ok: true }),
  });

  assert.deepEqual(outcome, {
    ok: false,
    failure: { ok: false, reasonCode: 'ptc_lab_browser_execution_failed' },
  });
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /geulbat-private|\.geulbat|secret/u,
  );
});

function createSessionManager(
  args:
    | { handle: PtcSessionDockerHandle }
    | { reasonCode: 'container_create_failed' },
): PtcSessionDockerManager {
  return {
    async getOrCreate(identity) {
      assert.deepEqual(identity, IDENTITY);
      if ('reasonCode' in args) {
        return {
          ok: false,
          reasonCode: args.reasonCode,
          message: 'session unavailable',
        };
      }
      return { ok: true, value: args.handle };
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      return { ok: true, value: undefined };
    },
  };
}

function createHandle(): PtcSessionDockerHandle {
  return {
    artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
    artifactRootHostPath: '/artifacts',
    artifactWorkspaceMountPolicyId: 'artifact-workspace-mount-v1',
    callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
    callbackRootHostPath: '/callbacks',
    containerId: 'container-browser-fixed-command',
    packageCacheId: 'package-cache-default',
    packageCacheIdentityHash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    packageCacheMountPolicyId: 'package-cache-mount-v1',
    packageCacheRootContainerPath:
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
    packageCacheRootHostPath: '/package-cache',
    reuseKey: {} as PtcSessionDockerHandle['reuseKey'],
    state: 'ready',
  };
}
