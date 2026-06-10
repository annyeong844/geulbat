import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildPtcPackageCacheRoot } from './lab-package-cache.js';
import {
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache-contract.js';
import {
  createPtcLabBrowserFixedPreflightPolicy,
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserUserUrlNavigationPolicy,
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
} from './lab-browser-policy.js';
import { createPtcLabOpenEgressLocalPolicy } from './lab-network-policy.js';
import { createPtcLabLocalDockerBatchCommandPolicyProjection } from './lab-profile.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID } from './lab-profile-contract.js';
import {
  createPtcSessionDockerManager,
  normalizePtcSessionDockerReuseKey,
} from './session-docker.js';
import {
  buildPtcSessionDockerArtifactRoot,
  buildPtcSessionDockerCallbackRoot,
  buildPtcSessionDockerSessionRoot,
} from './session-docker-host-roots.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerIdentity,
} from './session-docker-contract.js';

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

const PTC_SOURCE_ROOT_URL = new URL(
  '../../../src/daemon/ptc/',
  import.meta.url,
);
const STATIC_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:(?:[^'"]*?\s+from\s+)|)['"]([^'"]+)['"]/gu;

async function collectPtcStaticImportGraph(
  entryUrl: URL,
): Promise<Map<string, string[]>> {
  const visited = new Set<string>();
  const graph = new Map<string, string[]>();

  async function visit(sourceUrl: URL): Promise<void> {
    const sourcePath = sourceUrl.pathname;
    if (visited.has(sourcePath)) {
      return;
    }
    visited.add(sourcePath);

    const source = await readFile(sourceUrl, 'utf8');
    const specifiers = [...source.matchAll(STATIC_IMPORT_PATTERN)].map(
      (match) => match[1] ?? '',
    );
    graph.set(sourcePath, specifiers);

    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const childUrl = resolvePtcStaticImportUrl(sourceUrl, specifier);
      if (childUrl.pathname.startsWith(PTC_SOURCE_ROOT_URL.pathname)) {
        await visit(childUrl);
      }
    }
  }

  await visit(entryUrl);
  return graph;
}

function resolvePtcStaticImportUrl(sourceUrl: URL, specifier: string): URL {
  const sourceSpecifier = specifier.endsWith('.js')
    ? `${specifier.slice(0, -3)}.ts`
    : specifier;
  return new URL(sourceSpecifier, sourceUrl);
}

void test('extracted PTC implementation owners do not re-export contract bindings', async () => {
  const ownerSources = [
    'lab-command-execution.ts',
    'session-docker.ts',
    'lab-package-cache.ts',
    'lab-profile.ts',
    'lab-browser-navigation.ts',
    'lab-browser-owner.ts',
    'lab-browser-page-load-evidence.ts',
    'lab-browser-runtime.ts',
    'lab-browser-user-url-navigation.ts',
    'lab-session-batch-command.ts',
    'lab-package-install.ts',
    'session-docker-command.ts',
    'session-docker-create-args.ts',
    'session-docker-host-roots.ts',
  ];
  for (const ownerSource of ownerSources) {
    const source = await readFile(
      new URL(`../../../src/daemon/ptc/${ownerSource}`, import.meta.url),
      'utf8',
    );
    assert.equal(
      /export\s+(?:type\s+)?\{[\s\S]*?from\s+['"]\.\/[^'"]+-contract\.js['"]/u.test(
        source,
      ),
      false,
      ownerSource,
    );
  }
});

void test('session-docker contract owner does not directly or transitively import lifecycle or spawn implementation', async () => {
  const graph = await collectPtcStaticImportGraph(
    new URL(
      '../../../src/daemon/ptc/session-docker-contract.ts',
      import.meta.url,
    ),
  );
  const forbiddenSpecifiers = new Set([
    'node:child_process',
    'node:fs/promises',
  ]);
  const forbiddenSourceSuffixes = [
    '/session-docker.ts',
    '/host-path-mode.ts',
    '/output-redaction.ts',
    '/lab-package-cache.ts',
  ];

  for (const [sourcePath, specifiers] of graph) {
    assert.equal(
      forbiddenSourceSuffixes.some((suffix) => sourcePath.endsWith(suffix)),
      false,
      sourcePath,
    );
    for (const specifier of specifiers) {
      assert.equal(
        forbiddenSpecifiers.has(specifier),
        false,
        `${sourcePath} imports ${specifier}`,
      );
    }
  }
});

void test('session-docker host-roots owner does not own reuse-key normalization or Docker execution', async () => {
  const sourceUrl = new URL(
    '../../../src/daemon/ptc/session-docker-host-roots.ts',
    import.meta.url,
  );
  const source = await readFile(sourceUrl, 'utf8');

  assert.doesNotMatch(source, /normalizePtcSessionDockerReuseKey/u);
  assert.doesNotMatch(source, /sha256StableJson/u);
  assert.doesNotMatch(source, /buildPtcSessionDockerCreateArgs/u);
  assert.doesNotMatch(source, /runPtcSessionDockerCommand/u);
  assert.doesNotMatch(source, /PtcSessionDockerPolicy/u);

  const graph = await collectPtcStaticImportGraph(sourceUrl);
  for (const [sourcePath, specifiers] of graph) {
    assert.equal(sourcePath.endsWith('/session-docker.ts'), false, sourcePath);
    assert.equal(
      specifiers.includes('node:child_process'),
      false,
      `${sourcePath} imports node:child_process`,
    );
  }
});

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
  assert.equal(reuseKey.imageRef, 'local/geulbat-ptc-session:2026-05-31');
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

  const changedArtifactPolicy = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      artifactWorkspaceMountPolicyId: 'ptc_session_artifact_workspace_mount_v2',
    },
  });

  assert.notEqual(changedArtifactPolicy.identityHash, reuseKey.identityHash);

  const changedImageRef = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      imageRef: 'local/geulbat-ptc-session:2026-06-06',
    },
  });
  assert.notEqual(changedImageRef.identityHash, reuseKey.identityHash);

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

  const browserPolicy = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserFixedPreflightPolicy({ maxActionMs: 1200 }),
    },
  });
  assert.notEqual(browserPolicy.identityHash, reuseKey.identityHash);
  assert.equal(browserPolicy.browser.enabled, true);
  assert.equal(
    browserPolicy.browser.browserPolicyId,
    PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
  );
  assert.equal(browserPolicy.browser.maxActionMs, 1200);
  assert.equal(
    browserPolicy.packageCacheIdentityHash,
    reuseKey.packageCacheIdentityHash,
  );
  assert.match(reuseKey.identityHash, /^[a-f0-9]{64}$/u);
});

void test('normalizePtcSessionDockerReuseKey separates resource budget drift from cache identity', () => {
  const basePolicy = createPtcSessionDockerLocalBatchCommandPolicy();
  const baseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: basePolicy,
  });
  const changedResourceKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
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

void test('normalizePtcSessionDockerReuseKey separates browser policy drift from cache identity', () => {
  const baseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 1400,
      }),
    },
  });
  const changedActionBudgetKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserUserUrlNavigationPolicy({
        maxActionMs: 1401,
      }),
    },
  });
  const changedEvidenceBudgetKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      browser: createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: 1400,
        maxTitleChars: 81,
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
  assert.equal(changedEvidenceBudgetKey.browser.maxTitleChars, 81);
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    if (!session.ok) {
      assert.fail(session.message);
    }
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey: session.value.reuseKey,
    });
    const sessionsRoot = dirname(sessionRoot);

    await chmod(sessionsRoot, 0o500);
    try {
      const close = await manager.close(IDENTITY);
      if (close.ok) {
        assert.fail('expected host-root cleanup failure');
      }
      assert.equal(close.reasonCode, 'container_host_root_cleanup_failed');
      assert.equal(close.diagnostics?.cleanupFailed, true);
      assert.match(
        String(close.diagnostics?.cleanupErrorCode),
        /^(?:EACCES|EPERM)$/u,
      );
      assert.doesNotMatch(
        JSON.stringify(close),
        /\.geulbat|\/real\/workspace|\/geulbat-ptc-session/u,
      );
    } finally {
      await chmod(sessionsRoot, 0o700);
    }
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
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

void test('PtcSessionDockerManager classifies missing open network bridge without creating networks', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathWorkspaceRoot: async () => '/real/workspace',
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
        if (invocation.args[0] === 'create') {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr:
              'Error response from daemon: network geulbat-ptc-lab-open-v1 not found',
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
    assert.equal(
      invocations.some((invocation) =>
        invocation.args.join(' ').includes('network create'),
      ),
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
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
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
