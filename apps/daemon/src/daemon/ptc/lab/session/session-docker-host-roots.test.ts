import assert from 'node:assert/strict';
import { access, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  PTC_TEST_SESSION_DOCKER_IDENTITY as IDENTITY,
  withTempPtcSessionDockerRuntimeRoot as withTempRuntimeRoot,
} from '../../../../test-support/ptc-session-docker.js';
import { buildPtcPackageCacheRoot } from '../packages/lab-package-cache-root.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../packages/lab-package-cache-contract.js';
import { createPtcEpochCallbackChannel } from '../../callback/epoch-callback.js';
import { normalizePtcSessionDockerReuseKey } from './session-docker.js';
import {
  buildPtcSessionDockerArtifactRoot,
  buildPtcSessionDockerCallbackRoot,
  buildPtcSessionDockerSessionRoot,
  preparePtcSessionDockerHostDirs,
  removePtcSessionDockerHostRoot,
} from './session-docker-host-roots.js';
import { PTC_SESSION_DOCKER_DEFAULT_POLICY } from './session-docker-contract.js';

void test('PTC session Docker root builders keep callbacks and artifacts separate', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });

    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey,
    });
    const artifactRoot = buildPtcSessionDockerArtifactRoot({
      runtimeRoot,
      reuseKey,
    });
    const callbackRoot = buildPtcSessionDockerCallbackRoot({
      runtimeRoot,
      reuseKey,
    });
    const packageCacheRoot = buildPtcPackageCacheRoot({
      runtimeRoot,
      identity: {
        trustContextId: reuseKey.trustContextId,
        stateRootRealpath: reuseKey.stateRootRealpath,
        labPolicyId: reuseKey.labPolicyId,
        packageCacheId: reuseKey.packageCacheId,
        packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
        packageManagerFamilies: reuseKey.packageManagerFamilies,
        lifecycleScriptsPolicyId: reuseKey.lifecycleScriptsPolicyId,
        networkInstallPolicyId: reuseKey.networkInstallPolicyId,
        cacheIdentityHash: reuseKey.packageCacheIdentityHash,
      },
    });

    assert.equal(
      sessionRoot.endsWith(`/s/${reuseKey.identityHash.slice(0, 16)}`),
      true,
    );
    if (process.platform === 'win32') {
      assert.equal(callbackRoot, `${sessionRoot}/c`);
    } else {
      assert.equal(callbackRoot.startsWith(`${runtimeRoot}/`), false);
      assert.equal(callbackRoot.endsWith('/c'), true);
    }
    assert.equal(artifactRoot, `${sessionRoot}/a`);
    assert.equal(
      packageCacheRoot.hostPath,
      join(
        runtimeRoot,
        'ptc-package-caches',
        reuseKey.packageCacheIdentityHash,
      ),
    );
    assert.equal(
      packageCacheRoot.containerPath,
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
    );
    assert.notEqual(artifactRoot, callbackRoot);
    assert.equal(
      packageCacheRoot.hostPath.startsWith(`${sessionRoot}/`),
      false,
    );
  });
});

void test(
  'PTC session callback sockets remain usable with a long durable runtime root',
  { skip: process.platform === 'win32' },
  async () => {
    await withTempRuntimeRoot(async (tempRoot) => {
      const runtimeRoot = join(tempRoot, 'durable-runtime-root-'.repeat(5));
      await mkdir(runtimeRoot, { recursive: true });
      const reuseKey = normalizePtcSessionDockerReuseKey({
        identity: IDENTITY,
        stateRootRealpath: '/real/workspace/project-a',
        policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
      });
      const legacySocketPath = join(
        buildPtcSessionDockerSessionRoot({ runtimeRoot, reuseKey }),
        'c',
        'ptc-epoch-XXXXXX',
        'callback.sock',
      );
      const hostDirs = await preparePtcSessionDockerHostDirs({
        runtimeRoot,
        reuseKey,
      });
      assert.equal((await stat(hostDirs.callbackRoot)).mode & 0o777, 0o700);
      let channel:
        | Awaited<ReturnType<typeof createPtcEpochCallbackChannel>>
        | undefined;
      try {
        channel = await createPtcEpochCallbackChannel({
          rootDir: hostDirs.callbackRoot,
          handler: async () => ({
            ok: true,
            result: { kind: 'inline', value: 'ok' },
          }),
        });
        assert.equal(channel.socketPath.startsWith(`${runtimeRoot}/`), false);
        assert.equal(
          Buffer.byteLength(channel.socketPath, 'utf8') <
            Buffer.byteLength(legacySocketPath, 'utf8'),
          true,
        );
        await access(channel.socketPath);
      } finally {
        await channel?.close();
        const cleanup = await removePtcSessionDockerHostRoot({
          runtimeRoot,
          reuseKey,
        });
        assert.equal(cleanup.ok, true);
        await assert.rejects(() => access(hostDirs.callbackRoot), /ENOENT/u);
      }
    });
  },
);
