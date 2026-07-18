import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
} from '../browser/core/lab-browser-policy-ids.js';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  ptcStaticImportGraphIncludesSource,
  ptcStaticImportGraphIncludesSpecifier,
  readPtcStaticImportEdges,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import { buildPtcPackageCacheRoot } from '../packages/lab-package-cache-root.js';
import {
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from '../packages/lab-package-cache-contract.js';
import {
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserUserUrlNavigationPolicy,
} from '../browser/core/lab-browser-policy.js';
import {
  createPtcLabOpenEgressLocalPolicy,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
} from '../network/lab-network-policy.js';
import { createPtcLabLocalDockerBatchCommandPolicyProjection } from '../profile/lab-profile.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID } from '../profile/lab-profile-contract.js';
import {
  createPtcSessionDockerManager,
  normalizePtcSessionDockerReuseKey,
} from './session-docker.js';
import { buildPtcSessionDockerRuntimeScopeHash } from './session-docker-create-args.js';
import {
  buildPtcSessionDockerArtifactRoot,
  buildPtcSessionDockerCallbackRoot,
  buildPtcSessionDockerSessionRoot,
} from './session-docker-host-roots.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID,
  resolvePtcSessionDockerResourceRequirements,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerHostUser,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerReuseKey,
} from './session-docker-contract.js';

void test('Docker resource requirements are derived from the canonical session policy', () => {
  assert.deepEqual(
    resolvePtcSessionDockerResourceRequirements(
      createPtcSessionDockerLocalBatchCommandPolicy(),
    ),
    { cpuUnits: 2, memoryBytes: 2 * 1_024 ** 3 },
  );
});

const IDENTITY: PtcSessionDockerIdentity = {
  threadId: 'thread-ptc-1',
  stateRoot: '/workspace/project-a',
  trustContextId: 'local-default-v1',
};

const HOST_USER: PtcSessionDockerHostUser = {
  hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  uid: 1000,
  gid: 1000,
};

const OTHER_HOST_USER: PtcSessionDockerHostUser = {
  hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  uid: 2000,
  gid: 2000,
};

function packageCacheHostRootFor(args: {
  runtimeRoot: string;
  reuseKey: PtcSessionDockerReuseKey;
}): string {
  return buildPtcPackageCacheRoot({
    runtimeRoot: args.runtimeRoot,
    identity: {
      trustContextId: args.reuseKey.trustContextId,
      stateRootRealpath: args.reuseKey.stateRootRealpath,
      ...(args.reuseKey.ephemeralBurstId === undefined
        ? {}
        : { ephemeralBurstId: args.reuseKey.ephemeralBurstId }),
      labPolicyId: args.reuseKey.labPolicyId,
      packageCacheId: args.reuseKey.packageCacheId,
      packageCacheMountPolicyId: args.reuseKey.packageCacheMountPolicyId,
      packageManagerFamilies: args.reuseKey.packageManagerFamilies,
      lifecycleScriptsPolicyId: args.reuseKey.lifecycleScriptsPolicyId,
      networkInstallPolicyId: args.reuseKey.networkInstallPolicyId,
      cacheIdentityHash: args.reuseKey.packageCacheIdentityHash,
    },
  }).hostPath;
}

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

void test('extracted PTC implementation owners do not re-export contract bindings', async () => {
  const ownerSources = [
    'lab/browser/page-load-evidence/lab-browser-page-load-evidence.ts',
    'lab/browser/user-url-navigation/lab-browser-user-url-navigation.ts',
    'lab/packages/lab-package-cache.ts',
    'lab/packages/lab-package-install.ts',
    'lab/profile/lab-profile.ts',
    'lab/session/session-docker-command.ts',
    'lab/session/session-docker-create-args.ts',
    'lab/session/session-docker-host-roots.ts',
    'lab/session/session-docker.ts',
    'lab/shell/lab-command-execution.ts',
    'lab/shell/lab-session-batch-command.ts',
  ];
  for (const ownerSource of ownerSources) {
    const contractReExports = (
      await readPtcStaticImportEdges(ptcSourceUrl(ownerSource))
    ).filter(
      (edge) =>
        edge.statementKind === 'export' &&
        /(?:^|\/)[^/]+-contract\.js$/u.test(edge.specifier),
    );
    assert.deepEqual(
      contractReExports.map((edge) => edge.specifier),
      [],
      ownerSource,
    );
  }
});

void test('session-docker contract owner does not directly or transitively import lifecycle or spawn implementation', async () => {
  const graph = await collectPtcStaticImportGraph(
    ptcSourceUrl('lab/session/session-docker-contract.ts'),
  );
  const forbiddenSourceSuffixes = [
    '/lab/packages/lab-package-cache.ts',
    '/lab/session/host-path-mode.ts',
    '/lab/session/session-docker.ts',
    '/shared/output-redaction.ts',
  ];

  for (const forbiddenSource of forbiddenSourceSuffixes) {
    assert.equal(
      ptcStaticImportGraphIncludesSource(graph, forbiddenSource),
      false,
      forbiddenSource,
    );
  }
  for (const forbiddenSpecifier of ['node:child_process', 'node:fs/promises']) {
    assert.equal(
      ptcStaticImportGraphIncludesSpecifier(graph, forbiddenSpecifier),
      false,
      forbiddenSpecifier,
    );
  }
});

void test('session-docker host-roots owner does not own reuse-key normalization or Docker execution', async () => {
  const sourceUrl = ptcSourceUrl('lab/session/session-docker-host-roots.ts');
  const graph = await collectPtcStaticImportGraph(sourceUrl);
  const directSpecifiers = readPtcStaticImportSpecifiers(graph, sourceUrl);

  for (const forbiddenDirectSpecifier of [
    '../../shared/stable-identity.js',
    './session-docker.js',
    './session-docker-create-args.js',
    './session-docker-command.js',
  ]) {
    assert.equal(
      directSpecifiers.includes(forbiddenDirectSpecifier),
      false,
      forbiddenDirectSpecifier,
    );
  }

  for (const forbiddenSource of [
    '/lab/packages/lab-package-cache.ts',
    '/lab/session/session-docker.ts',
    '/lab/session/session-docker-create-args.ts',
    '/lab/session/session-docker-command.ts',
    '/shared/output-redaction.ts',
  ]) {
    assert.equal(
      ptcStaticImportGraphIncludesSource(graph, forbiddenSource),
      false,
      forbiddenSource,
    );
  }
  assert.equal(
    ptcStaticImportGraphIncludesSpecifier(graph, 'node:child_process'),
    false,
  );
});

void test('normalizePtcSessionDockerReuseKey includes canonical workspace and policy ids', () => {
  const reuseKey = normalizePtcSessionDockerReuseKey({
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
  });

  assert.equal(reuseKey.threadId, 'thread-ptc-1');
  assert.equal(reuseKey.stateRootRealpath, '/real/workspace/project-a');
  assert.equal(reuseKey.trustContextId, 'local-default-v1');
  assert.equal(reuseKey.launchPolicyId, 'ptc_session_docker_launch_v1');
  assert.equal(reuseKey.imageRef, 'local/geulbat-ptc-session:2026-05-31');
  assert.equal(reuseKey.imagePolicyId, 'ptc_session_docker_image_v1');
  assert.equal(
    reuseKey.idleEntrypointVersion,
    'ptc_session_idle_entrypoint_v1',
  );
  assert.deepEqual(reuseKey.hostUser, HOST_USER);
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
  assert.equal(reuseKey.browser.enabled, false);
  assert.equal(
    reuseKey.browser.browserPolicyId,
    PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  );
  assert.equal(reuseKey.cpus, '1');
  assert.equal(reuseKey.memory, '512m');
  assert.equal(reuseKey.pidsLimit, '128');
  assert.equal(
    reuseKey.scratchTmpfs,
    '/geulbat/scratch:rw,noexec,nosuid,nodev,size=64m',
  );
  assert.equal(reuseKey.tmpTmpfs, '/tmp:rw,nosuid,nodev,size=64m');
  assert.match(reuseKey.packageCacheIdentityHash, /^[a-f0-9]{64}$/u);

  const changedNetworkPolicy = normalizePtcSessionDockerReuseKey({
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      networkInstallPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
      network: createPtcLabOpenEgressLocalPolicy(),
    },
  });

  assert.notEqual(changedNetworkPolicy.identityHash, reuseKey.identityHash);
  assert.notEqual(
    changedNetworkPolicy.packageCacheIdentityHash,
    reuseKey.packageCacheIdentityHash,
  );

  const changedImageRef = normalizePtcSessionDockerReuseKey({
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      imageRef: 'local/geulbat-ptc-session:2026-06-06',
    },
  });
  assert.notEqual(changedImageRef.identityHash, reuseKey.identityHash);

  const changedPackageCachePolicy = normalizePtcSessionDockerReuseKey({
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
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
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      packageManagerFamilies: ['pip', 'npm'],
    },
  });
  const secondManagerOrder = normalizePtcSessionDockerReuseKey({
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
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

  const browserPolicy = normalizePtcSessionDockerReuseKey({
    hostUser: HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 1200,
      }),
    },
  });
  assert.notEqual(browserPolicy.identityHash, reuseKey.identityHash);
  assert.equal(browserPolicy.browser.enabled, true);
  assert.equal(
    browserPolicy.browser.browserPolicyId,
    PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
  );
  assert.equal(browserPolicy.browser.maxActionMs, 1200);
  assert.equal(
    browserPolicy.packageCacheIdentityHash,
    reuseKey.packageCacheIdentityHash,
  );
  assert.match(reuseKey.identityHash, /^[a-f0-9]{64}$/u);

  const changedHostUser = normalizePtcSessionDockerReuseKey({
    hostUser: OTHER_HOST_USER,
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
  });
  assert.notEqual(changedHostUser.identityHash, reuseKey.identityHash);
  assert.equal(
    changedHostUser.packageCacheIdentityHash,
    reuseKey.packageCacheIdentityHash,
  );
});

void test('normalizePtcSessionDockerReuseKey separates resource budget drift from cache identity', () => {
  const basePolicy = createPtcSessionDockerLocalBatchCommandPolicy();
  const baseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: basePolicy,
  });
  const changedResourceKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...basePolicy,
      memory: '4g',
    },
  });

  assert.equal(
    basePolicy.labPolicyId,
    PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
  );
  assert.equal(
    basePolicy.labPolicyId,
    createPtcLabLocalDockerBatchCommandPolicyProjection().policyId,
  );
  assert.equal(
    basePolicy.launchPolicyId,
    PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID,
  );
  assert.equal(baseKey.cpus, '2');
  assert.equal(baseKey.memory, '2g');
  assert.equal(baseKey.pidsLimit, '256');
  assert.equal(
    baseKey.scratchTmpfs,
    '/geulbat/scratch:rw,noexec,nosuid,nodev,size=512m',
  );
  assert.equal(baseKey.tmpTmpfs, '/tmp:rw,nosuid,nodev,size=512m');
  assert.notEqual(changedResourceKey.identityHash, baseKey.identityHash);
  assert.equal(
    changedResourceKey.packageCacheIdentityHash,
    baseKey.packageCacheIdentityHash,
  );
});

void test('ephemeral burst identity isolates both session and package cache roots', () => {
  const policy = createPtcSessionDockerLocalBatchCommandPolicy();
  const warm = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy,
  });
  const firstBurst = normalizePtcSessionDockerReuseKey({
    identity: { ...IDENTITY, ephemeralBurstId: 'ptc_burst_first' },
    stateRootRealpath: '/real/workspace/project-a',
    policy,
  });
  const secondBurst = normalizePtcSessionDockerReuseKey({
    identity: { ...IDENTITY, ephemeralBurstId: 'ptc_burst_second' },
    stateRootRealpath: '/real/workspace/project-a',
    policy,
  });

  assert.equal(warm.ephemeralBurstId, undefined);
  assert.equal(firstBurst.ephemeralBurstId, 'ptc_burst_first');
  assert.notEqual(firstBurst.identityHash, warm.identityHash);
  assert.notEqual(
    firstBurst.packageCacheIdentityHash,
    warm.packageCacheIdentityHash,
  );
  assert.notEqual(firstBurst.identityHash, secondBurst.identityHash);
  assert.notEqual(
    firstBurst.packageCacheIdentityHash,
    secondBurst.packageCacheIdentityHash,
  );
});

void test('normalizePtcSessionDockerReuseKey separates browser policy drift from cache identity', () => {
  const baseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 1400,
      }),
    },
  });
  const changedActionBudgetKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 1401,
      }),
    },
  });
  const changedEvidenceBudgetKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    stateRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: 1400,
      }),
    },
  });

  if (baseKey.browser.mode !== 'user_url_navigation') {
    throw new Error('expected user URL browser identity');
  }
  if (changedActionBudgetKey.browser.mode !== 'user_url_navigation') {
    throw new Error('expected changed user URL browser identity');
  }
  if (changedEvidenceBudgetKey.browser.mode !== 'page_load_evidence') {
    throw new Error('expected page-load evidence browser identity');
  }

  assert.equal(baseKey.browser.maxActionMs, 1400);
  assert.equal(changedActionBudgetKey.browser.maxActionMs, 1401);
  assert.notEqual(changedActionBudgetKey.identityHash, baseKey.identityHash);
  assert.notEqual(changedEvidenceBudgetKey.identityHash, baseKey.identityHash);
  assert.equal(
    changedActionBudgetKey.packageCacheIdentityHash,
    baseKey.packageCacheIdentityHash,
  );
  assert.equal(
    changedEvidenceBudgetKey.packageCacheIdentityHash,
    baseKey.packageCacheIdentityHash,
  );
});

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
    assert.equal(callbackRoot, `${sessionRoot}/c`);
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
          /^type=bind,src=([^,]+),dst=\/geulbat\/callbacks$/u.exec(
            mountSpec ?? '',
          )?.[1];
        assert.ok(callbackRoot);
        await access(callbackRoot);
        const callbackRootStat = await stat(callbackRoot);
        assert.equal(callbackRootStat.isDirectory(), true);
        const packageCacheMountSpec = invocation.args.find((item) =>
          item.includes(
            `,dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}`,
          ),
        );
        assert.ok(packageCacheMountSpec);
        const packageCacheRoot =
          /^type=bind,src=([^,]+),dst=\/geulbat\/package-cache$/u.exec(
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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
    assert.equal(
      invocations.every((invocation) => invocation.timeoutMs === undefined),
      true,
    );
  });
});

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
          stdout: `stale-burst|${staleKey.identityHash}|${staleKey.packageCacheIdentityHash}\n`,
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey,
    });
    const packageCacheRoot = packageCacheHostRootFor({ runtimeRoot, reuseKey });
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
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'container_start_failed');
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-start-fail']);
    await assert.rejects(() => access(sessionRoot), /ENOENT/u);
    await access(packageCacheRoot);
  });
});

void test('PtcSessionDockerManager removes created container and host root when inspect fails', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: string[][] = [];
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey,
    });
    const packageCacheRoot = packageCacheHostRootFor({ runtimeRoot, reuseKey });
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
          stdout: 'container-inspect-fail\n',
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
          stdout: '{not-json',
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

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'container_inspect_failed',
    );
    assert.equal(
      result.ok ? '' : result.diagnostics?.dockerInspectFailureKind,
      'invalid_json',
    );
    assert.doesNotMatch(JSON.stringify(result), /\{not-json/u);
    assert.deepEqual(invocations.at(-1), [
      'rm',
      '-f',
      'container-inspect-fail',
    ]);
    await assert.rejects(() => access(sessionRoot), /ENOENT/u);
    await access(packageCacheRoot);
  });
});

void test('PtcSessionDockerManager creates the open network bridge before launching an open-network session (slice 1b)', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathStateRoot: async () => '/real/workspace',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'Docker version',
            stderr: '',
          };
        }
        if (invocation.args[0] === 'image') {
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'inspect'
        ) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'Error: No such network: geulbat-ptc-lab-open-v1',
          };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'create'
        ) {
          return { kind: 'exit', exitCode: 0, stdout: 'net-id\n', stderr: '' };
        }
        if (invocation.args[0] === 'create') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'container-open-1\n',
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
              { Id: 'container-open-1', State: { Running: true } },
            ]),
            stderr: '',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, true);
    const order = invocations.map((invocation) => invocation.args.join(' '));
    const networkCreateIndex = order.findIndex((line) =>
      line.startsWith('network create'),
    );
    const containerCreateIndex = order.findIndex((line) =>
      line.startsWith('create'),
    );
    assert.notEqual(networkCreateIndex, -1);
    assert.notEqual(containerCreateIndex, -1);
    assert.ok(networkCreateIndex < containerCreateIndex);
    const networkCreateCall = invocations[networkCreateIndex];
    assert.ok(networkCreateCall);
    assert.equal(networkCreateCall.args.at(-1), 'geulbat-ptc-lab-open-v1');
  });
});

void test('PtcSessionDockerManager adopts an existing open network bridge without recreating it', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathStateRoot: async () => '/real/workspace',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return { kind: 'exit', exitCode: 0, stdout: 'v', stderr: '' };
        }
        if (invocation.args[0] === 'image') {
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'inspect'
        ) {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: JSON.stringify([{ Name: 'geulbat-ptc-lab-open-v1' }]),
            stderr: '',
          };
        }
        if (invocation.args[0] === 'create') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'container-open-2\n',
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
              { Id: 'container-open-2', State: { Running: true } },
            ]),
            stderr: '',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, true);
    assert.equal(
      invocations.some((invocation) =>
        invocation.args.join(' ').startsWith('network create'),
      ),
      false,
    );
  });
});

void test('PtcSessionDockerManager fails closed when the open network bridge cannot be ensured', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathStateRoot: async () => '/real/workspace',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return { kind: 'exit', exitCode: 0, stdout: 'v', stderr: '' };
        }
        if (invocation.args[0] === 'image') {
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'inspect'
        ) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'Error: No such network',
          };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'create'
        ) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'Error response from daemon: permission denied',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'network_backend_unavailable',
    );
    // Ensure failed before any container was created.
    assert.equal(
      invocations.some((invocation) => invocation.args[0] === 'create'),
      false,
    );
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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

void test('PtcSessionDockerManager rejects getOrCreate requested during closeAll cleanup', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    let markRemoveStarted!: () => void;
    let releaseRemove!: () => void;
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve;
    });
    const removeReleased = new Promise<void>((resolve) => {
      releaseRemove = resolve;
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
        markRemoveStarted();
        await removeReleased;
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const first = await manager.getOrCreate(IDENTITY);
    assert.equal(first.ok ? first.value.containerId : '', 'container-1');

    const closeAll = manager.closeAll();
    await removeStarted;
    const duringCloseAll = manager.getOrCreate(IDENTITY);
    releaseRemove();

    assert.equal((await closeAll).ok, true);
    const duringCloseAllResult = await duringCloseAll;
    assert.equal(duringCloseAllResult.ok, false);
    assert.equal(
      duringCloseAllResult.ok ? '' : duringCloseAllResult.reasonCode,
      'manager_closing',
    );
    assert.equal(createCount, 1);

    const afterCloseAll = await manager.getOrCreate(IDENTITY);
    assert.equal(
      afterCloseAll.ok ? afterCloseAll.value.containerId : '',
      'container-2',
    );
    assert.equal(invocations.filter((args) => args[0] === 'create').length, 2);
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
      realpathStateRoot: async () => '/real/workspace/project-a',
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
