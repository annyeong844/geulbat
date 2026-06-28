import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_RUNTIME_INPUT_MAX_BYTES,
  runPtcLabBrowserRuntimeCommand,
  runPtcLabBrowserRuntimeCommandAttempt,
} from './lab-browser-runtime-command.js';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  ptcStaticImportGraphIncludesSource,
  readPtcStaticImportSpecifiers,
} from '../../../../../test-support/ptc-static-import-graph.js';
import type { PtcSha256Digest } from '../../../shared/browser-evidence-contract.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  type PtcSessionDockerHandle,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
} from '../../session/session-docker-contract.js';
import {
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from '../../packages/lab-package-cache-contract.js';

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-browser-runtime-command',
  trustContextId: 'trust-local-v1',
  workspaceRoot: '/workspace/project-a',
});

const ATTEMPT_DIGEST = `sha256:${'a'.repeat(64)}` as PtcSha256Digest;

void test('browser runtime command owner imports only private command and close boundaries', async () => {
  const sourceUrl = ptcSourceUrl(
    'lab/browser/core/lab-browser-runtime-command.ts',
  );
  const graph = await collectPtcStaticImportGraph(sourceUrl);
  const directSpecifiers = readPtcStaticImportSpecifiers(graph, sourceUrl);

  assert.deepEqual(directSpecifiers, [
    'node:fs/promises',
    'node:path',
    '../../session/session-docker-command.js',
    '../../session/session-taint-close.js',
    '../../session/session-docker-contract.js',
    '../../../shared/record-shape.js',
  ]);
  for (const forbiddenSource of [
    '/lab/browser/user-url-navigation/',
    '/lab/browser/page-load-evidence/',
    '/lab/browser/text-evidence/',
    '/lab/browser/core/lab-browser-result-contract.ts',
  ]) {
    assert.equal(
      ptcStaticImportGraphIncludesSource(graph, forbiddenSource),
      false,
      forbiddenSource,
    );
  }
});

void test('runPtcLabBrowserRuntimeCommand writes bounded private input and returns command-layer result only', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    let inputHostPath = '';
    const outcome = await runPtcLabBrowserRuntimeCommand({
      attemptDigest: ATTEMPT_DIGEST,
      handle: createHandle(callbackRootHostPath),
      identity: IDENTITY,
      inputEnvelope: {
        loadWaitState: 'domcontentloaded',
        targetUrl: 'https://example.com/private?access_token=secret',
        timeoutMs: 1000,
      },
      ownerKind: 'user_url_navigation',
      runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
      sessionManager: createCloseRecorder().manager,
      timeoutMs: 1000,
      commandRunner: async (invocation) => {
        const inputContainerPath = invocation.args.at(-1);
        assert.ok(inputContainerPath);
        assert.deepEqual(invocation.args, [
          'exec',
          'container-browser-runtime-command',
          'node',
          '-e',
          'globalThis.__GEULBAT_RUNTIME__ = true;',
          inputContainerPath,
        ]);

        inputHostPath = join(
          callbackRootHostPath,
          basename(inputContainerPath),
        );
        assert.match(
          basename(inputHostPath),
          /^ptc-browser-user-url-navigation-[0-9a-f]{64}\.json$/u,
        );
        assert.deepEqual(JSON.parse(await readFile(inputHostPath, 'utf8')), {
          loadWaitState: 'domcontentloaded',
          targetUrl: 'https://example.com/private?access_token=secret',
          timeoutMs: 1000,
        });
        assert.equal((await stat(inputHostPath)).mode & 0o777, 0o600);
        return { kind: 'timeout', stdout: '', stderr: 'private stderr' };
      },
    });

    assert.deepEqual(outcome, {
      inputCleanup: { attempted: true, status: 'removed' },
      primary: {
        kind: 'command_result',
        result: { kind: 'timeout', stdout: '', stderr: 'private stderr' },
      },
    });
    await assert.rejects(access(inputHostPath));
  });
});

void test('runPtcLabBrowserRuntimeCommand rejects unsafe digest-derived names before command execution', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    for (const attemptDigest of [
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}/`,
      'https://example.com/private?access_token=secret',
    ]) {
      let commandCalled = false;
      const close = createCloseRecorder();
      const outcome = await runPtcLabBrowserRuntimeCommand({
        attemptDigest,
        commandRunner: async () => {
          commandCalled = true;
          return { kind: 'crash', stdout: '', stderr: '' };
        },
        handle: createHandle(callbackRootHostPath),
        identity: IDENTITY,
        inputEnvelope: { timeoutMs: 1000 },
        ownerKind: 'page_load_evidence',
        runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
        sessionManager: close.manager,
        timeoutMs: 1000,
      });

      assert.equal(commandCalled, false);
      assert.equal(close.calls, 0);
      assert.deepEqual(outcome, {
        inputCleanup: { attempted: false, status: 'not_needed' },
        primary: { kind: 'not_started', reason: 'input_prepare_failed' },
      });
    }
  });
});

void test('runPtcLabBrowserRuntimeCommand preserves runner throw as primary fact without raw leak', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    let inputHostPath = '';
    const close = createCloseRecorder();
    const outcome = await runPtcLabBrowserRuntimeCommand({
      attemptDigest: ATTEMPT_DIGEST,
      commandRunner: async (invocation) => {
        const inputContainerPath = invocation.args.at(-1);
        assert.ok(inputContainerPath);
        inputHostPath = join(
          callbackRootHostPath,
          basename(inputContainerPath),
        );
        throw new Error('/tmp/geulbat-private/.geulbat/secret should not leak');
      },
      handle: createHandle(callbackRootHostPath),
      identity: IDENTITY,
      inputEnvelope: { timeoutMs: 1000 },
      ownerKind: 'user_url_navigation',
      runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
      sessionManager: close.manager,
      timeoutMs: 1000,
    });

    assert.equal(close.calls, 0);
    assert.deepEqual(outcome, {
      inputCleanup: { attempted: true, status: 'removed' },
      primary: { kind: 'runner_threw' },
    });
    assert.doesNotMatch(
      JSON.stringify(outcome),
      /geulbat-private|\.geulbat|secret/u,
    );
    await assert.rejects(access(inputHostPath));
  });
});

void test('runPtcLabBrowserRuntimeCommand keeps timeout primary and taint-closes exactly once on cleanup failure', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    const close = createCloseRecorder();
    const outcome = await runPtcLabBrowserRuntimeCommand({
      attemptDigest: ATTEMPT_DIGEST,
      commandRunner: async (invocation) => {
        const inputContainerPath = invocation.args.at(-1);
        assert.ok(inputContainerPath);
        const inputHostPath = join(
          callbackRootHostPath,
          basename(inputContainerPath),
        );
        await rm(inputHostPath);
        await mkdir(inputHostPath);
        return { kind: 'timeout', stdout: '', stderr: 'private stderr' };
      },
      handle: createHandle(callbackRootHostPath),
      identity: IDENTITY,
      inputEnvelope: { timeoutMs: 1000 },
      ownerKind: 'page_load_evidence',
      runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
      sessionManager: close.manager,
      timeoutMs: 1000,
    });

    assert.equal(close.calls, 1);
    assert.equal(outcome.primary.kind, 'command_result');
    assert.equal(
      outcome.primary.kind === 'command_result'
        ? outcome.primary.result.kind
        : '',
      'timeout',
    );
    assert.equal(outcome.inputCleanup.status, 'failed');
    assert.equal(
      outcome.inputCleanup.status === 'failed'
        ? outcome.inputCleanup.closeOutcome.closeStatus
        : '',
      'succeeded',
    );
  });
});

void test('runPtcLabBrowserRuntimeCommand does not taint-close input prepare failure before file creation', async () => {
  const callbackRootHostPath = join(
    tmpdir(),
    `missing-geulbat-browser-runtime-${process.pid}`,
  );
  await rm(callbackRootHostPath, { force: true, recursive: true });

  let commandCalled = false;
  const close = createCloseRecorder();
  const outcome = await runPtcLabBrowserRuntimeCommand({
    attemptDigest: ATTEMPT_DIGEST,
    commandRunner: async () => {
      commandCalled = true;
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
    },
    handle: createHandle(callbackRootHostPath),
    identity: IDENTITY,
    inputEnvelope: { timeoutMs: 1000 },
    ownerKind: 'user_url_navigation',
    runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
    sessionManager: close.manager,
    timeoutMs: 1000,
  });

  assert.equal(commandCalled, false);
  assert.equal(close.calls, 0);
  assert.deepEqual(outcome, {
    inputCleanup: { attempted: false, status: 'not_needed' },
    primary: { kind: 'not_started', reason: 'input_prepare_failed' },
  });
});

void test('runPtcLabBrowserRuntimeCommand taint-closes input prepare failure after possible file creation', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    const inputHostPath = join(
      callbackRootHostPath,
      `ptc-browser-user-url-navigation-${'a'.repeat(64)}.json`,
    );
    await mkdir(inputHostPath);

    const close = createCloseRecorder();
    const outcome = await runPtcLabBrowserRuntimeCommand({
      attemptDigest: ATTEMPT_DIGEST,
      handle: createHandle(callbackRootHostPath),
      identity: IDENTITY,
      inputEnvelope: { timeoutMs: 1000 },
      ownerKind: 'user_url_navigation',
      runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
      sessionManager: close.manager,
      timeoutMs: 1000,
      commandRunner: async () => {
        throw new Error('command must not run');
      },
    });

    assert.equal(close.calls, 1);
    assert.equal(outcome.primary.kind, 'not_started');
    assert.equal(outcome.inputCleanup.status, 'failed');
  });
});

void test('runPtcLabBrowserRuntimeCommand rejects oversized input before command execution', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    let commandCalled = false;
    const close = createCloseRecorder();
    const outcome = await runPtcLabBrowserRuntimeCommand({
      attemptDigest: ATTEMPT_DIGEST,
      commandRunner: async () => {
        commandCalled = true;
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
      handle: createHandle(callbackRootHostPath),
      identity: IDENTITY,
      inputEnvelope: {
        payload: 'x'.repeat(PTC_LAB_BROWSER_RUNTIME_INPUT_MAX_BYTES),
      },
      ownerKind: 'page_load_evidence',
      runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
      sessionManager: close.manager,
      timeoutMs: 1000,
    });

    assert.equal(commandCalled, false);
    assert.equal(close.calls, 0);
    assert.deepEqual(outcome, {
      inputCleanup: { attempted: false, status: 'not_needed' },
      primary: { kind: 'not_started', reason: 'input_prepare_failed' },
    });
  });
});

void test('runPtcLabBrowserRuntimeCommandAttempt stops on session acquisition failure before validation or command execution', async () => {
  let validateCalled = false;
  let commandCalled = false;
  const outcome = await runPtcLabBrowserRuntimeCommandAttempt({
    attemptDigest: ATTEMPT_DIGEST,
    commandRunner: async () => {
      commandCalled = true;
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
    },
    identity: IDENTITY,
    inputEnvelope: { timeoutMs: 1000 },
    ownerKind: 'user_url_navigation',
    runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
    sessionManager: createAttemptSessionManager({
      getOrCreate: async () => ({
        ok: false,
        reasonCode: 'container_create_failed',
        message: 'private docker error',
      }),
    }),
    sessionUnavailable: (reasonCode) => ({ ok: false as const, reasonCode }),
    timeoutMs: 1000,
    validateSession: () => {
      validateCalled = true;
      return { ok: true };
    },
  });

  assert.deepEqual(outcome, {
    ok: false,
    failure: { ok: false, reasonCode: 'container_create_failed' },
  });
  assert.equal(validateCalled, false);
  assert.equal(commandCalled, false);
});

void test('runPtcLabBrowserRuntimeCommandAttempt stops on session validation failure before command execution', async () => {
  await withTempCallbackRoot(async (callbackRootHostPath) => {
    let commandCalled = false;
    const outcome = await runPtcLabBrowserRuntimeCommandAttempt({
      attemptDigest: ATTEMPT_DIGEST,
      commandRunner: async () => {
        commandCalled = true;
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
      identity: IDENTITY,
      inputEnvelope: { timeoutMs: 1000 },
      ownerKind: 'page_load_evidence',
      runtimeScript: 'globalThis.__GEULBAT_RUNTIME__ = true;',
      sessionManager: createAttemptSessionManager({
        getOrCreate: async () => ({
          ok: true,
          value: createHandle(callbackRootHostPath),
        }),
      }),
      sessionUnavailable: (reasonCode) => ({ ok: false as const, reasonCode }),
      timeoutMs: 1000,
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
});

async function withTempCallbackRoot<T>(
  fn: (callbackRootHostPath: string) => Promise<T>,
): Promise<T> {
  const callbackRootHostPath = await mkdtemp(
    join(tmpdir(), 'geulbat-browser-runtime-command-'),
  );
  try {
    return await fn(callbackRootHostPath);
  } finally {
    await rm(callbackRootHostPath, { force: true, recursive: true });
  }
}

function createAttemptSessionManager(args: {
  getOrCreate: PtcSessionDockerManager['getOrCreate'];
}): PtcSessionDockerManager {
  const close = createCloseRecorder();
  return {
    getOrCreate: args.getOrCreate,
    close: close.manager.close,
    async closeAll() {
      return { ok: true, value: undefined };
    },
  };
}

function createHandle(callbackRootHostPath: string): PtcSessionDockerHandle {
  return {
    artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
    artifactRootHostPath: '/artifacts',
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
    callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
    callbackRootHostPath,
    containerId: 'container-browser-runtime-command',
    packageCacheId: 'package-cache-default',
    packageCacheIdentityHash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    packageCacheMountPolicyId: PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
    packageCacheRootContainerPath:
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
    packageCacheRootHostPath: '/package-cache',
    reuseKey: {} as PtcSessionDockerHandle['reuseKey'],
    state: 'ready',
  };
}

function createCloseRecorder(): {
  readonly calls: number;
  manager: {
    close(identity: PtcSessionDockerIdentity): Promise<{
      ok: true;
      value: undefined;
    }>;
  };
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    manager: {
      async close(identity) {
        calls += 1;
        assert.deepEqual(identity, IDENTITY);
        return { ok: true, value: undefined };
      },
    },
  };
}
