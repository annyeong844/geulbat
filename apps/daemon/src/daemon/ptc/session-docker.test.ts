import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPtcPackageCacheRoot,
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache.js';
import {
  buildPtcSessionDockerArtifactRoot,
  buildPtcSessionDockerCallbackRoot,
  buildPtcSessionDockerCreateArgs,
  buildPtcSessionDockerSessionRoot,
  createPtcSessionDockerManager,
  normalizePtcSessionDockerReuseKey,
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  runPtcSessionDockerCommand,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerIdentity,
} from './session-docker.js';

const IDENTITY: PtcSessionDockerIdentity = {
  threadId: 'thread-ptc-1',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'local-default-v1',
};

async function withTempRuntimeRoot<T>(
  fn: (runtimeRoot: string) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-session-'));
  try {
    return await fn(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

void test('normalizePtcSessionDockerReuseKey includes canonical workspace and policy ids', () => {
  const reuseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
  });

  assert.equal(reuseKey.threadId, 'thread-ptc-1');
  assert.equal(reuseKey.workspaceRootRealpath, '/real/workspace/project-a');
  assert.equal(reuseKey.trustContextId, 'local-default-v1');
  assert.equal(reuseKey.launchPolicyId, 'ptc_session_docker_launch_v1');
  assert.equal(reuseKey.imagePolicyId, 'ptc_session_docker_image_v1');
  assert.equal(
    reuseKey.idleEntrypointVersion,
    'ptc_session_idle_entrypoint_v1',
  );
  assert.equal(reuseKey.callbackMountPolicyId, 'ptc_session_callback_mount_v1');
  assert.equal(
    reuseKey.artifactWorkspaceMountPolicyId,
    PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  );
  assert.equal(reuseKey.labPolicyId, 'ptc_lab_local_docker_policy_v1');
  assert.equal(reuseKey.packageCacheId, PTC_LAB_PACKAGE_CACHE_DEFAULT_ID);
  assert.equal(
    reuseKey.packageCacheMountPolicyId,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  );
  assert.equal(
    reuseKey.packageCacheRootContainerPath,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  );
  assert.deepEqual(reuseKey.packageManagerFamilies, []);
  assert.match(reuseKey.packageCacheIdentityHash, /^[a-f0-9]{64}$/u);

  const changedArtifactPolicy = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      artifactWorkspaceMountPolicyId: 'ptc_session_artifact_workspace_mount_v2',
    },
  });

  assert.notEqual(changedArtifactPolicy.identityHash, reuseKey.identityHash);

  const changedPackageCachePolicy = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      packageCacheId: 'ptc_lab_other_cache_v1',
    },
  });
  assert.notEqual(
    changedPackageCachePolicy.identityHash,
    reuseKey.identityHash,
  );
  assert.notEqual(
    changedPackageCachePolicy.packageCacheIdentityHash,
    reuseKey.packageCacheIdentityHash,
  );

  const firstManagerOrder = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      packageManagerFamilies: ['pip', 'npm'],
    },
  });
  const secondManagerOrder = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      packageManagerFamilies: ['npm', 'pip'],
    },
  });
  assert.deepEqual(firstManagerOrder.packageManagerFamilies, ['npm', 'pip']);
  assert.equal(firstManagerOrder.identityHash, secondManagerOrder.identityHash);
  assert.equal(
    firstManagerOrder.packageCacheIdentityHash,
    secondManagerOrder.packageCacheIdentityHash,
  );
  assert.match(reuseKey.identityHash, /^[a-f0-9]{64}$/u);
});

void test('buildPtcSessionDockerCreateArgs uses ambient-zero args and callback root mount', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      workspaceRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const args = buildPtcSessionDockerCreateArgs({
      reuseKey,
      runtimeRoot,
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });

    assert.equal(args[0], 'create');
    assert.equal(args.includes('--network'), true);
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.equal(args.includes('--read-only'), true);
    assert.equal(args.includes('--cap-drop'), true);
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(args.includes('--security-opt'), true);
    assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.equal(args.includes('--tmpfs'), true);
    assert.equal(args.includes('--mount'), true);
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/ptc-sessions/`) &&
          item.endsWith(
            `,dst=${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT},rw`,
          ),
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/ptc-sessions/`) &&
          item.endsWith(
            `,dst=${PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT},rw`,
          ),
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/ptc-package-caches/`) &&
          item.endsWith(
            `,dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT},rw`,
          ),
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item ===
          `geulbat.artifactWorkspaceMountPolicyId=${PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID}`,
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item ===
          `geulbat.packageCacheMountPolicyId=${PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID}`,
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item === `geulbat.packageCacheId=${PTC_LAB_PACKAGE_CACHE_DEFAULT_ID}`,
      ),
      true,
    );
    assert.equal(
      args.some((item: string) =>
        item.startsWith('geulbat.packageCacheIdentityHash='),
      ),
      true,
    );
    assert.equal(args.includes('/var/run/docker.sock'), false);
    assert.equal(
      args.some((item: string) => item.includes('NPM_TOKEN')),
      false,
    );
    assert.equal(
      args.some((item: string) => item.includes('PIP_INDEX_URL')),
      false,
    );
    assert.equal(
      args.some((item: string) => item.includes('/workspace/project-a')),
      false,
    );
    assert.equal(
      args.some((item: string) => item.includes('/real/workspace/project-a')),
      false,
    );
    assert.equal(
      args.some((item: string) => item.includes('.geulbat')),
      false,
    );
    assert.equal(
      args.some((item: string) => item.includes('GEULBAT_PROVIDER')),
      false,
    );
  });
});

void test('PTC session Docker root builders keep callbacks and artifacts separate', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      workspaceRootRealpath: '/real/workspace/project-a',
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
        workspaceRootRealpath: reuseKey.workspaceRootRealpath,
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
      sessionRoot.endsWith(`/ptc-sessions/${reuseKey.identityHash}`),
      true,
    );
    assert.equal(callbackRoot, `${sessionRoot}/callbacks`);
    assert.equal(artifactRoot, `${sessionRoot}/artifacts`);
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
    assert.equal(packageCacheRoot.hostPath.includes('/ptc-sessions/'), false);
  });
});

void test('PtcSessionDockerManager creates, inspects, reuses, and closes one container', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation);
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
        const mountIndex = invocation.args.indexOf('--mount');
        const mountSpec =
          mountIndex >= 0 ? invocation.args[mountIndex + 1] : '';
        const callbackRoot =
          /^type=bind,src=([^,]+),dst=\/geulbat\/callbacks,rw$/u.exec(
            mountSpec ?? '',
          )?.[1];
        assert.ok(callbackRoot);
        await access(callbackRoot);
        const callbackRootStat = await stat(callbackRoot);
        assert.equal(callbackRootStat.isDirectory(), true);
        const packageCacheMountSpec = invocation.args.find((item) =>
          item.includes(
            `,dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT},rw`,
          ),
        );
        assert.ok(packageCacheMountSpec);
        const packageCacheRoot =
          /^type=bind,src=([^,]+),dst=\/geulbat\/package-cache,rw$/u.exec(
            packageCacheMountSpec,
          )?.[1];
        assert.ok(packageCacheRoot);
        await access(packageCacheRoot);
        const packageCacheRootStat = await stat(packageCacheRoot);
        assert.equal(packageCacheRootStat.isDirectory(), true);
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const first = await manager.getOrCreate(IDENTITY);
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.value.containerId : '', 'container-1');
    assert.equal(first.ok ? first.value.state : '', 'ready');
    const artifactRoot = first.ok ? first.value.artifactRootHostPath : '';
    const packageCacheRoot = first.ok
      ? first.value.packageCacheRootHostPath
      : '';
    await access(artifactRoot);
    await access(packageCacheRoot);

    const second = await manager.getOrCreate(IDENTITY);
    assert.equal(second.ok, true);
    assert.equal(second.ok ? second.value.containerId : '', 'container-1');

    const close = await manager.close(IDENTITY);
    assert.equal(close.ok, true);
    await assert.rejects(() => access(artifactRoot), /ENOENT/u);
    await access(packageCacheRoot);

    const commandNames = invocations.map((invocation) => invocation.args[0]);
    assert.equal(commandNames.filter((name) => name === 'create').length, 1);
    assert.equal(commandNames.filter((name) => name === 'rm').length, 1);
    assert.equal(
      commandNames.filter((name) => name === 'inspect').length >= 1,
      true,
    );
  });
});

void test('PtcSessionDockerManager single-flights concurrent getOrCreate calls', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let markCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
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
      if (invocation.args[0] === 'create') {
        markCreateStarted();
        await createReleased;
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const first = manager.getOrCreate(IDENTITY);
    const second = manager.getOrCreate(IDENTITY);
    await createStarted;
    releaseCreate();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(
      firstResult.ok && secondResult.ok
        ? firstResult.value.containerId === secondResult.value.containerId
        : false,
      true,
    );
    assert.equal(invocations.filter((args) => args[0] === 'create').length, 1);
  });
});

void test('PtcSessionDockerManager removes created container when start fails', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
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
      if (invocation.args[0] === 'create') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-start-fail\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'start failed',
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'container_start_failed');
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-start-fail']);
  });
});

void test('PtcSessionDockerManager recreates a tracked container that no longer runs', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    let inspectCount = 0;
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
        inspectCount += 1;
        const containerId = invocation.args[1] ?? '';
        const running = inspectCount !== 2;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: running } },
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const first = await manager.getOrCreate(IDENTITY);
    assert.equal(first.ok, true);
    const oldArtifactRoot = first.ok ? first.value.artifactRootHostPath : '';
    const oldPackageCacheRoot = first.ok
      ? first.value.packageCacheRootHostPath
      : '';
    const staleMarker = join(oldArtifactRoot, 'stale-output.txt');
    const packageCacheMarker = join(oldPackageCacheRoot, 'keep-cache.txt');
    await writeFile(staleMarker, 'stale', 'utf8');
    await writeFile(packageCacheMarker, 'cache', 'utf8');
    const second = await manager.getOrCreate(IDENTITY);

    assert.equal(first.ok ? first.value.containerId : '', 'container-1');
    assert.equal(second.ok ? second.value.containerId : '', 'container-2');
    await assert.rejects(() => access(staleMarker), /ENOENT/u);
    await access(packageCacheMarker);
    await access(second.ok ? second.value.artifactRootHostPath : '');
    assert.equal(
      second.ok ? second.value.packageCacheRootHostPath : '',
      oldPackageCacheRoot,
    );
    assert.deepEqual(invocations.filter((args) => args[0] === 'rm').at(0), [
      'rm',
      '-f',
      'container-1',
    ]);
  });
});

void test('PtcSessionDockerManager close during startup removes the created container', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let markCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
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
      if (invocation.args[0] === 'create') {
        markCreateStarted();
        await createReleased;
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const start = manager.getOrCreate(IDENTITY);
    await createStarted;
    const close = manager.close(IDENTITY);
    releaseCreate();
    assert.equal((await start).ok, true);
    assert.equal((await close).ok, true);
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-1']);
  });
});

void test('PtcSessionDockerManager closeAll during startup removes the created container', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let markCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
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
      if (invocation.args[0] === 'create') {
        markCreateStarted();
        await createReleased;
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const start = manager.getOrCreate(IDENTITY);
    await createStarted;
    const closeAll = manager.closeAll();
    releaseCreate();
    assert.equal((await start).ok, true);
    assert.equal((await closeAll).ok, true);
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-1']);
  });
});

void test('PtcSessionDockerManager getOrCreate works again after closeAll cleanup', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: string[][] = [];
    let createCount = 0;
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const first = await manager.getOrCreate(IDENTITY);
    const closeAll = await manager.closeAll();
    const second = await manager.getOrCreate(IDENTITY);

    assert.equal(first.ok ? first.value.containerId : '', 'container-1');
    assert.equal(closeAll.ok, true);
    assert.equal(second.ok ? second.value.containerId : '', 'container-2');
    assert.equal(invocations.filter((args) => args[0] === 'create').length, 2);
    assert.deepEqual(invocations.filter((args) => args[0] === 'rm').at(0), [
      'rm',
      '-f',
      'container-1',
    ]);
  });
});

void test('PtcSessionDockerManager diagnostics redact private path markers', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: async (invocation) => {
        if (invocation.args[0] === '--version') {
          return {
            kind: 'exit',
            exitCode: 127,
            stdout: '',
            stderr:
              'failed at /workspace/project-a/.geulbat/private, /tmp/geulbat-ptc-session-abc/ptc-sessions/hash/callbacks, and /var/run/docker.sock',
          };
        }
        throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
      },
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /\.geulbat/u);
    assert.doesNotMatch(text, /\/tmp\/geulbat-ptc-session/u);
    assert.doesNotMatch(text, /\/var\/run\/docker\.sock/u);
    assert.match(text, /\[redacted:path\]/u);
    assert.match(text, /\[redacted:docker-socket\]/u);
  });
});

void test('runPtcSessionDockerCommand executes argv without shell interpolation', async () => {
  const result = await runPtcSessionDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'console.log(process.argv.slice(1).join("|"))',
      'a b',
      'semi;colon',
    ],
    timeoutMs: 1000,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.match(result.stdout, /a b\|semi;colon/u);
});

void test('runPtcSessionDockerCommand caps stdout and stderr capture', async () => {
  const result = await runPtcSessionDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    timeoutMs: 1000,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8') <= 66 * 1024, true);
  assert.equal(Buffer.byteLength(result.stderr, 'utf8') <= 66 * 1024, true);
  assert.match(result.stdout, /\[truncated\]/u);
  assert.match(result.stderr, /\[truncated\]/u);
});
