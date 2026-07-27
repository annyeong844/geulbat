import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
} from '../browser/core/lab-browser-policy-ids.js';
import test from 'node:test';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  ptcStaticImportGraphIncludesSource,
  ptcStaticImportGraphIncludesSpecifier,
  readPtcStaticImportEdges,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import { PTC_TEST_SESSION_DOCKER_IDENTITY as IDENTITY } from '../../../../test-support/ptc-session-docker.js';
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
import { normalizePtcSessionDockerReuseKey } from './session-docker.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID,
  resolvePtcSessionDockerResourceRequirements,
  type PtcSessionDockerHostUser,
} from './session-docker-contract.js';

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

void test('Docker resource requirements are derived from the canonical session policy', () => {
  assert.deepEqual(
    resolvePtcSessionDockerResourceRequirements(
      createPtcSessionDockerLocalBatchCommandPolicy(),
    ),
    { cpuUnits: 2, memoryBytes: 2 * 1_024 ** 3 },
  );
});

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
