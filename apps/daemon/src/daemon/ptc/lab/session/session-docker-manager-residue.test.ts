import assert from 'node:assert/strict';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  buildPtcSessionDockerPackageCacheHostRoot as packageCacheHostRootFor,
  PTC_TEST_SESSION_DOCKER_IDENTITY as IDENTITY,
  withTempPtcSessionDockerRuntimeRoot as withTempRuntimeRoot,
} from '../../../../test-support/ptc-session-docker.js';
import {
  createPtcSessionDockerManager,
  normalizePtcSessionDockerReuseKey,
} from './session-docker.js';
import { buildPtcSessionDockerSessionRoot } from './session-docker-host-roots.js';
import {
  buildPtcSessionDockerRuntimeScopeHash,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerIdentity,
} from './session-docker-contract.js';

async function replaceSessionsRootWithFile(
  sessionRoot: string,
): Promise<string> {
  const sessionsRoot = dirname(sessionRoot);
  await rm(sessionsRoot, { recursive: true, force: true });
  await writeFile(sessionsRoot, 'not-a-directory', 'utf8');
  return sessionsRoot;
}

async function restoreSessionsRootDirectory(
  sessionsRoot: string,
): Promise<void> {
  await rm(sessionsRoot, { force: true });
  await mkdir(sessionsRoot, { recursive: true });
}

void test('PtcSessionDockerManager removes burst-owned package cache on close', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const burstIdentity: PtcSessionDockerIdentity = {
      ...IDENTITY,
      ephemeralBurstId: 'ptc_burst_close_cleanup',
    };
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      switch (invocation.args[0]) {
        case '--version':
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'Docker version 27',
            stderr: '',
          };
        case 'image':
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        case 'create':
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'container-burst-close\n',
            stderr: '',
          };
        case 'start':
        case 'rm':
          return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
        case 'inspect':
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: JSON.stringify([
              { Id: 'container-burst-close', State: { Running: true } },
            ]),
            stderr: '',
          };
        default:
          throw new Error(
            `unexpected docker args: ${invocation.args.join(' ')}`,
          );
      }
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(burstIdentity);
    assert.equal(session.ok, true);
    if (!session.ok) {
      return;
    }
    await access(session.value.artifactRootHostPath);
    await access(session.value.packageCacheRootHostPath);

    assert.deepEqual(await manager.close(burstIdentity), {
      ok: true,
      value: undefined,
    });
    await assert.rejects(
      () => access(session.value.artifactRootHostPath),
      /ENOENT/u,
    );
    await assert.rejects(
      () => access(session.value.packageCacheRootHostPath),
      /ENOENT/u,
    );
  });
});

void test('PtcSessionDockerManager sweeps scoped ephemeral residue once before first use', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const staleKey = normalizePtcSessionDockerReuseKey({
      identity: {
        ...IDENTITY,
        ephemeralBurstId: 'ptc_burst_startup_residue',
      },
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const staleSessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey: staleKey,
    });
    const stalePackageCacheRoot = packageCacheHostRootFor({
      runtimeRoot,
      reuseKey: staleKey,
    });
    await mkdir(staleSessionRoot, { recursive: true });
    await mkdir(stalePackageCacheRoot, { recursive: true });

    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation);
      if (invocation.args[0] === 'ps') {
        assert.equal(
          invocation.args.includes('label=geulbat.ephemeral=true'),
          true,
        );
        assert.equal(
          invocation.args.includes(
            `label=geulbat.runtimeScopeHash=${buildPtcSessionDockerRuntimeScopeHash(runtimeRoot)}`,
          ),
          true,
        );
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `stale-burst|${staleKey.identityHash}|${staleKey.packageCacheIdentityHash}|true\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-after-sweep\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start' || invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: 'container-after-sweep', State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      reapEphemeralOnFirstUse: true,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    assert.equal(session.ok, true);
    await assert.rejects(() => access(staleSessionRoot), /ENOENT/u);
    await assert.rejects(() => access(stalePackageCacheRoot), /ENOENT/u);
    assert.equal(
      invocations.filter((invocation) => invocation.args[0] === 'ps').length,
      1,
    );
    const staleRemove = invocations.find(
      (invocation) =>
        invocation.args[0] === 'rm' && invocation.args.includes('stale-burst'),
    );
    assert.deepEqual(staleRemove?.args, ['rm', '-f', 'stale-burst']);
    await manager.close(IDENTITY);
  });
});

void test('PtcSessionDockerManager re-adopts a matching running container before sweeping unowned restart residue', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const stateRootRealpath = '/real/workspace/project-a';
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath,
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const runtimeScopeHash = buildPtcSessionDockerRuntimeScopeHash(runtimeRoot);
    const staleIdentityHash = 'a'.repeat(64);
    const stalePackageCacheIdentityHash = 'b'.repeat(64);
    const removedContainerGroups: string[][] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Id: 'container-adopted',
              State: { Running: true },
              Config: {
                Labels: {
                  'geulbat.kind': 'ptc-session',
                  'geulbat.owner': 'daemon',
                  'geulbat.identityHash': reuseKey.identityHash,
                  'geulbat.runtimeScopeHash': runtimeScopeHash,
                  'geulbat.packageCacheIdentityHash':
                    reuseKey.packageCacheIdentityHash,
                },
              },
            },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'ps') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: [
            [
              'container-adopted',
              reuseKey.identityHash,
              reuseKey.packageCacheIdentityHash,
              '',
            ].join('|'),
            [
              'container-stale',
              staleIdentityHash,
              stalePackageCacheIdentityHash,
              '',
            ].join('|'),
          ].join('\n'),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        removedContainerGroups.push(invocation.args.slice(2));
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => stateRootRealpath,
    });
    assert.notEqual(manager.adoptExisting, undefined);
    if (manager.adoptExisting === undefined) {
      return;
    }

    const adopted = await manager.adoptExisting(IDENTITY, {
      containerId: 'container-adopted',
    });
    assert.equal(adopted.ok, true);
    if (!adopted.ok) {
      return;
    }
    assert.equal(adopted.value.containerId, 'container-adopted');

    assert.deepEqual(await manager.reapRestartResidue?.(), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(removedContainerGroups, [['container-stale']]);

    assert.deepEqual(await manager.closeAll(), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(removedContainerGroups, [
      ['container-stale'],
      ['container-adopted'],
    ]);
  });
});

void test('PtcSessionDockerManager restart cleanup reaps all prior containers without deleting reusable caches', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const persistentKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const ephemeralKey = normalizePtcSessionDockerReuseKey({
      identity: {
        ...IDENTITY,
        ephemeralBurstId: 'ptc_burst_restart_residue',
      },
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const persistentSessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey: persistentKey,
    });
    const ephemeralSessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey: ephemeralKey,
    });
    const persistentPackageCacheRoot = packageCacheHostRootFor({
      runtimeRoot,
      reuseKey: persistentKey,
    });
    const ephemeralPackageCacheRoot = packageCacheHostRootFor({
      runtimeRoot,
      reuseKey: ephemeralKey,
    });
    await Promise.all(
      [
        persistentSessionRoot,
        ephemeralSessionRoot,
        persistentPackageCacheRoot,
        ephemeralPackageCacheRoot,
      ].map((path) => mkdir(path, { recursive: true })),
    );

    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      realpathStateRoot: async () => '/real/workspace/project-a',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === 'ps') {
          assert.equal(
            invocation.args.includes('label=geulbat.ephemeral=true'),
            false,
          );
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: [
              `persistent-before-restart|${persistentKey.identityHash}|${persistentKey.packageCacheIdentityHash}|`,
              `burst-before-restart|${ephemeralKey.identityHash}|${ephemeralKey.packageCacheIdentityHash}|true`,
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        if (invocation.args[0] === 'rm') {
          return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
      },
    });

    assert.deepEqual(await manager.reapRestartResidue?.(), {
      ok: true,
      value: undefined,
    });
    const remove = invocations.find(
      (invocation) => invocation.args[0] === 'rm',
    );
    assert.deepEqual(remove?.args, [
      'rm',
      '-f',
      'persistent-before-restart',
      'burst-before-restart',
    ]);
    await assert.rejects(() => access(persistentSessionRoot), /ENOENT/u);
    await assert.rejects(() => access(ephemeralSessionRoot), /ENOENT/u);
    await access(persistentPackageCacheRoot);
    await assert.rejects(() => access(ephemeralPackageCacheRoot), /ENOENT/u);
  });
});

void test('PtcSessionDockerManager fails closed on invalid ephemeral sweep labels', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      reapEphemeralOnFirstUse: true,
      realpathStateRoot: async () => '/real/workspace/project-a',
      commandRunner: async (invocation) => {
        assert.equal(invocation.args[0], 'ps');
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'forged-container|not-a-hash|also-not-a-hash\n',
          stderr: '',
        };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reasonCode, 'ephemeral_startup_sweep_failed');
      assert.deepEqual(result.diagnostics, { ephemeralLabelInvalid: true });
    }
  });
});

void test('PtcSessionDockerManager preserves sanitized host-root cleanup diagnostics', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-1\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: 'container-1', State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    if (!session.ok) {
      assert.fail(session.message);
    }
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey: session.value.reuseKey,
    });

    const sessionsRoot = await replaceSessionsRootWithFile(sessionRoot);
    try {
      const close = await manager.close(IDENTITY);
      if (close.ok) {
        assert.fail('expected host-root cleanup failure');
      }
      assert.equal(close.reasonCode, 'container_host_root_cleanup_failed');
      assert.equal(close.diagnostics?.cleanupFailed, true);
      assert.equal(close.diagnostics?.cleanupErrorCode, 'ENOTDIR');
      assert.doesNotMatch(
        JSON.stringify(close),
        /\.geulbat|\/real\/workspace|\/geulbat-ptc-session/u,
      );
    } finally {
      await restoreSessionsRootDirectory(sessionsRoot);
    }
  });
});

void test('PtcSessionDockerManager does not reuse a host root after cleanup fails', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        createCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `container-${createCount}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        const containerId = invocation.args[1] ?? '';
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    if (!session.ok) {
      assert.fail(session.message);
    }
    const artifactRoot = session.value.artifactRootHostPath;
    const staleMarker = join(artifactRoot, 'stale-after-cleanup-failure.txt');
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey: session.value.reuseKey,
    });
    await writeFile(staleMarker, 'stale', 'utf8');

    const sessionsRoot = await replaceSessionsRootWithFile(sessionRoot);
    try {
      const close = await manager.close(IDENTITY);
      assert.equal(close.ok, false);
      assert.equal(
        close.ok ? '' : close.reasonCode,
        'container_host_root_cleanup_failed',
      );

      const blockedReuse = await manager.getOrCreate(IDENTITY);
      assert.equal(blockedReuse.ok, false);
      assert.equal(
        blockedReuse.ok ? '' : blockedReuse.reasonCode,
        'container_host_root_cleanup_failed',
      );
      assert.equal(createCount, 1);
      assert.equal((await stat(sessionsRoot)).isFile(), true);
    } finally {
      await restoreSessionsRootDirectory(sessionsRoot);
    }

    const nextSession = await manager.getOrCreate(IDENTITY);
    if (!nextSession.ok) {
      assert.fail(nextSession.message);
    }
    assert.equal(nextSession.value.containerId, 'container-2');
    await assert.rejects(() => access(staleMarker), /ENOENT/u);
  });
});

void test('PtcSessionDockerManager does not reuse a tracked session after container removal fails', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    let rmCount = 0;
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        createCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `container-${createCount}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        const containerId = invocation.args[1] ?? '';
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        rmCount += 1;
        if (rmCount === 1) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'container removal failed',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    if (!session.ok) {
      assert.fail(session.message);
    }
    const artifactRoot = session.value.artifactRootHostPath;
    const packageCacheRoot = session.value.packageCacheRootHostPath;
    const staleMarker = join(artifactRoot, 'stale-tainted-output.txt');
    const packageCacheMarker = join(packageCacheRoot, 'keep-cache.txt');
    await writeFile(staleMarker, 'stale', 'utf8');
    await writeFile(packageCacheMarker, 'cache', 'utf8');
    await access(artifactRoot);

    const firstClose = await manager.close(IDENTITY);
    assert.equal(firstClose.ok, false);
    assert.equal(
      firstClose.ok ? '' : firstClose.reasonCode,
      'container_remove_failed',
    );
    await access(artifactRoot);

    const nextSession = await manager.getOrCreate(IDENTITY);
    assert.equal(nextSession.ok, true);
    assert.equal(
      nextSession.ok ? nextSession.value.containerId : '',
      'container-2',
    );
    assert.equal(rmCount, 2);
    await assert.rejects(() => access(staleMarker), /ENOENT/u);
    await access(packageCacheMarker);
  });
});

void test('PtcSessionDockerManager blocks replacement while tracked container removal keeps failing', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    let rmCount = 0;
    let allowCleanup = false;
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        createCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `container-${createCount}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        const containerId = invocation.args[1] ?? '';
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        rmCount += 1;
        if (!allowCleanup) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'container removal failed',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    if (!session.ok) {
      assert.fail(session.message);
    }
    const artifactRoot = session.value.artifactRootHostPath;
    const staleMarker = join(artifactRoot, 'stale-persistent-rm-failure.txt');
    await writeFile(staleMarker, 'stale', 'utf8');

    const firstClose = await manager.close(IDENTITY);
    assert.equal(firstClose.ok, false);
    assert.equal(
      firstClose.ok ? '' : firstClose.reasonCode,
      'container_remove_failed',
    );

    const blockedReplacement = await manager.getOrCreate(IDENTITY);
    assert.equal(blockedReplacement.ok, false);
    assert.equal(
      blockedReplacement.ok ? '' : blockedReplacement.reasonCode,
      'container_remove_failed',
    );
    assert.equal(createCount, 1);
    assert.equal(rmCount, 2);
    await access(staleMarker);

    allowCleanup = true;
    const recovered = await manager.getOrCreate(IDENTITY);
    assert.equal(recovered.ok, true);
    assert.equal(
      recovered.ok ? recovered.value.containerId : '',
      'container-2',
    );
    assert.equal(createCount, 2);
    assert.equal(rmCount, 3);
    await assert.rejects(() => access(staleMarker), /ENOENT/u);
  });
});

void test('PtcSessionDockerManager removes untracked stale session residue before replacement create', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const staleMarker = join(
      buildPtcSessionDockerSessionRoot({ runtimeRoot, reuseKey }),
      'a',
      'stale-from-previous-daemon.txt',
    );
    await mkdir(dirname(staleMarker), { recursive: true });
    await writeFile(staleMarker, 'stale', 'utf8');

    const invocations: string[][] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation.args);
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'ps') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'stale-container\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-1\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: 'container-1', State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    if (!session.ok) {
      assert.fail(session.message);
    }

    const psArgs = invocations.find((args) => args[0] === 'ps');
    assert.deepEqual(psArgs, [
      'ps',
      '-a',
      '--filter',
      'label=geulbat.kind=ptc-session',
      '--filter',
      `label=geulbat.identityHash=${reuseKey.identityHash}`,
      '--format',
      '{{.ID}}',
    ]);
    const rmIndex = invocations.findIndex((args) => args[0] === 'rm');
    const createIndex = invocations.findIndex((args) => args[0] === 'create');
    assert.deepEqual(invocations[rmIndex], ['rm', '-f', 'stale-container']);
    assert.equal(rmIndex > -1 && createIndex > rmIndex, true);
    await assert.rejects(() => access(staleMarker), /ENOENT/u);
  });
});
