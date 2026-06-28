import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
} from '../browser/core/lab-browser-policy-ids.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectPtcStaticImportGraph,
  ptcSourceUrl,
  ptcStaticImportGraphIncludesSource,
  ptcStaticImportGraphIncludesSpecifier,
  readPtcStaticImportSpecifiers,
} from '../../../../test-support/ptc-static-import-graph.js';
import {
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from '../packages/lab-package-cache-contract.js';
import {
  createPtcLabNetworkDisabledPolicy,
  createPtcLabOpenEgressLocalPolicy,
  PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
  PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
} from '../network/lab-network-policy.js';
import {
  createPtcLabBrowserPageLoadEvidencePolicy,
  createPtcLabBrowserUserUrlNavigationPolicy,
} from '../browser/core/lab-browser-policy.js';
import { buildPtcSessionDockerCreateArgs } from './session-docker-create-args.js';
import { normalizePtcSessionDockerReuseKey } from './session-docker.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  type PtcSessionDockerHostUser,
  type PtcSessionDockerIdentity,
} from './session-docker-contract.js';

const IDENTITY: PtcSessionDockerIdentity = {
  threadId: 'thread-ptc-1',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'local-default-v1',
};

const HOST_USER: PtcSessionDockerHostUser = {
  hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  uid: 1000,
  gid: 1000,
};

async function withTempRuntimeRoot<T>(
  fn: (runtimeRoot: string) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-create-args-'));
  try {
    return await fn(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

void test('session-docker create-args owner does not own reuse-key normalization, lifecycle, or command execution', async () => {
  const sourceUrl = ptcSourceUrl('lab/session/session-docker-create-args.ts');
  const graph = await collectPtcStaticImportGraph(sourceUrl);
  const directSpecifiers = readPtcStaticImportSpecifiers(graph, sourceUrl);

  assert.deepEqual(directSpecifiers, [
    '../packages/lab-package-cache-root.js',
    '../packages/lab-package-cache-contract.js',
    '../network/lab-network-policy.js',
    '../browser/core/lab-browser-identity.js',
    './session-docker-contract.js',
    './session-docker-host-roots.js',
    './session-docker-contract.js',
  ]);
  for (const forbiddenDirectSpecifier of [
    '../../shared/stable-identity.js',
    './session-docker.js',
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

void test('session-docker does not re-export the create-args owner after extraction', async () => {
  const sessionDockerExports = (await import('./session-docker.js')) as Record<
    string,
    unknown
  >;

  assert.equal(
    Object.prototype.hasOwnProperty.call(
      sessionDockerExports,
      'buildPtcSessionDockerCreateArgs',
    ),
    false,
  );
});

void test('buildPtcSessionDockerCreateArgs projects resource budget args from reuse key policy', () => {
  const policy = createPtcSessionDockerLocalBatchCommandPolicy();
  const reuseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy,
  });
  const args = buildPtcSessionDockerCreateArgs({
    reuseKey,
    runtimeRoot: '/runtime',
  });

  assert.equal(args[args.indexOf('--cpus') + 1], '2');
  assert.equal(args[args.indexOf('--memory') + 1], '2g');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '256');
  assert.equal(args.includes(reuseKey.scratchTmpfs), true);
  assert.equal(args.includes(reuseKey.tmpTmpfs), true);
  assert.equal(
    args.includes(`geulbat.labPolicyId=${reuseKey.labPolicyId}`),
    true,
  );
});

void test('buildPtcSessionDockerCreateArgs uses ambient-zero args and callback root mount', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const reuseKey = normalizePtcSessionDockerReuseKey({
      hostUser: HOST_USER,
      identity: IDENTITY,
      workspaceRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const args = buildPtcSessionDockerCreateArgs({
      reuseKey,
      runtimeRoot,
    });

    assert.equal(args[0], 'create');
    assert.equal(args.includes('--network'), true);
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.equal(args.includes('--read-only'), true);
    assert.equal(args.includes('--user'), true);
    assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
    assert.equal(args.includes('--cap-drop'), true);
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(args.includes('--security-opt'), true);
    assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.equal(args.includes('--tmpfs'), true);
    assert.equal(args.includes('--mount'), true);
    assert.equal(
      args.includes(
        `geulbat.hostUserPolicyId=${PTC_SESSION_DOCKER_HOST_USER_POLICY_ID}`,
      ),
      true,
    );
    assert.equal(
      args.some((item) => /geulbat\.host(?:Uid|Gid)=/u.test(item)),
      false,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/s/`) &&
          item.endsWith(`,dst=${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}`),
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/s/`) &&
          item.endsWith(`,dst=${PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT}`),
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/ptc-package-caches/`) &&
          item.endsWith(
            `,dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}`,
          ),
      ),
      true,
    );
    assert.equal(
      args.some((item: string) => item.endsWith(',rw')),
      false,
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
      args.includes(`geulbat.labPolicyId=${reuseKey.labPolicyId}`),
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
    assert.equal(
      args.includes(
        `geulbat.browserPolicyId=${PTC_LAB_BROWSER_DISABLED_POLICY_ID}`,
      ),
      true,
    );
    assert.equal(args.includes('geulbat.browserEnabled=false'), true);
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

void test('buildPtcSessionDockerCreateArgs projects disabled and open network policy', () => {
  const disabledPolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabNetworkDisabledPolicy(),
  };
  const openPolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
  };
  const disabledKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: disabledPolicy,
  });
  const openKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: openPolicy,
  });

  assert.notEqual(openKey.identityHash, disabledKey.identityHash);
  assert.equal(disabledKey.network.mode, 'disabled');
  assert.equal(openKey.network.mode, 'open');

  const disabledArgs = buildPtcSessionDockerCreateArgs({
    reuseKey: disabledKey,
    runtimeRoot: '/runtime',
  });
  const openArgs = buildPtcSessionDockerCreateArgs({
    reuseKey: openKey,
    runtimeRoot: '/runtime',
  });

  assert.equal(disabledArgs[disabledArgs.indexOf('--network') + 1], 'none');
  assert.equal(
    openArgs[openArgs.indexOf('--network') + 1],
    PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  );
  assert.equal(openArgs.includes('--network=host'), false);
  assert.equal(openArgs.includes('host'), false);
  assert.equal(
    openArgs.includes(
      `geulbat.networkPolicyId=${PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    openArgs.includes(
      `geulbat.networkExplicitOptInPolicyId=${PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    openArgs.includes(
      `geulbat.boundaryClaim=${PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM}`,
    ),
    true,
  );
});

void test('buildPtcSessionDockerCreateArgs projects browser policy labels', () => {
  const browserPolicy = createPtcLabBrowserUserUrlNavigationPolicy({
    maxActionMs: 1200,
  });
  const policy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: browserPolicy,
  };
  const reuseKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy,
  });
  const args = buildPtcSessionDockerCreateArgs({
    reuseKey,
    runtimeRoot: '/runtime',
  });

  assert.equal(reuseKey.browser.enabled, true);
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserNetworkPolicyId=${PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(args.includes('geulbat.browserMaxTabs=1'), true);
  assert.equal(
    args.some((item) => /cookie=|profile=|https?:\/\//iu.test(item)),
    false,
  );
});

void test('buildPtcSessionDockerCreateArgs projects browser capability policy identity', () => {
  const navigationPolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: createPtcLabBrowserUserUrlNavigationPolicy({
      maxActionMs: 1200,
    }),
  };
  const pageLoadPolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: createPtcLabBrowserPageLoadEvidencePolicy({
      maxNavigationMs: 1200,
    }),
  };
  const navigationKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: navigationPolicy,
  });
  const pageLoadKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: pageLoadPolicy,
  });
  const args = buildPtcSessionDockerCreateArgs({
    reuseKey: pageLoadKey,
    runtimeRoot: '/runtime',
  });

  assert.notEqual(pageLoadKey.identityHash, navigationKey.identityHash);
  assert.equal(
    pageLoadKey.packageCacheIdentityHash,
    navigationKey.packageCacheIdentityHash,
  );
  assert.equal(pageLoadKey.browser.enabled, true);
  if (
    !pageLoadKey.browser.enabled ||
    pageLoadKey.browser.mode !== 'page_load_evidence'
  ) {
    throw new Error('expected page-load browser identity');
  }
  assert.equal(
    pageLoadKey.browser.browserEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserEnginePolicyId=${PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID}`,
    ),
    false,
  );
  assert.equal(
    args.some((item) => /cookie=|profile=|https?:\/\//iu.test(item)),
    false,
  );
});
