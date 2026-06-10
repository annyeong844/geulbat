import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache-contract.js';
import {
  createPtcLabNetworkDisabledPolicy,
  createPtcLabOpenEgressLocalPolicy,
  PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
  PTC_LAB_OPEN_EGRESS_BOUNDARY_CLAIM,
  PTC_LAB_OPEN_EGRESS_EXPLICIT_LOCAL_POLICY_ID,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
} from './lab-network-policy.js';
import {
  createPtcLabBrowserFixedNavigationProbePolicy,
  createPtcLabBrowserFixedPreflightPolicy,
  createPtcLabBrowserFixedRuntimeProbePolicy,
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
} from './lab-browser-policy.js';
import { buildPtcSessionDockerCreateArgs } from './session-docker-create-args.js';
import { normalizePtcSessionDockerReuseKey } from './session-docker.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
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
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-create-args-'));
  try {
    return await fn(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

void test('session-docker create-args owner does not own reuse-key normalization, lifecycle, or command execution', async () => {
  const source = await readFile(
    new URL(
      '../../../src/daemon/ptc/session-docker-create-args.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(source, /normalizePtcSessionDockerReuseKey/u);
  assert.doesNotMatch(source, /createPtcSessionDockerManager/u);
  assert.doesNotMatch(source, /runPtcSessionDockerCommand/u);
  assert.doesNotMatch(source, /node:child_process/u);
  assert.doesNotMatch(source, /sanitizePtcPrivateMarkers|sanitizePtcOutput/u);
  assert.doesNotMatch(source, /PtcSessionDockerPolicy|args\.policy/u);
});

void test('session-docker does not re-export the create-args owner after extraction', async () => {
  const source = await readFile(
    new URL('../../../src/daemon/ptc/session-docker.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /export\s+(?:function\s+buildPtcSessionDockerCreateArgs|\{[\s\S]*buildPtcSessionDockerCreateArgs[\s\S]*\})/u,
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
    assert.equal(args.includes('--cap-drop'), true);
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(args.includes('--security-opt'), true);
    assert.equal(args[args.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.equal(args.includes('--tmpfs'), true);
    assert.equal(args.includes('--mount'), true);
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/s/`) &&
          item.endsWith(
            `,dst=${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT},rw`,
          ),
      ),
      true,
    );
    assert.equal(
      args.some(
        (item: string) =>
          item.startsWith(`type=bind,src=${runtimeRoot}/s/`) &&
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
  const browserPolicy = createPtcLabBrowserFixedPreflightPolicy({
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
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID}`,
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
  assert.equal(args.includes('geulbat.browserOutputPolicy=summary_only'), true);
  assert.equal(
    args.some((item) => /cookie=|profile=|https?:\/\//iu.test(item)),
    false,
  );
});

void test('buildPtcSessionDockerCreateArgs projects browser runtime policy identity', () => {
  const preflightPolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: createPtcLabBrowserFixedPreflightPolicy({
      maxActionMs: 1200,
    }),
  };
  const runtimePolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: createPtcLabBrowserFixedRuntimeProbePolicy({
      maxActionMs: 1200,
    }),
  };
  const preflightKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: preflightPolicy,
  });
  const runtimeKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: runtimePolicy,
  });
  const args = buildPtcSessionDockerCreateArgs({
    reuseKey: runtimeKey,
    runtimeRoot: '/runtime',
  });

  assert.notEqual(runtimeKey.identityHash, preflightKey.identityHash);
  assert.equal(
    runtimeKey.packageCacheIdentityHash,
    preflightKey.packageCacheIdentityHash,
  );
  assert.equal(runtimeKey.browser.enabled, true);
  assert.equal(runtimeKey.browser.mode, 'fixed_runtime_probe');
  if (
    !runtimeKey.browser.enabled ||
    runtimeKey.browser.mode !== 'fixed_runtime_probe'
  ) {
    throw new Error('expected fixed runtime browser identity');
  }
  assert.equal(
    runtimeKey.browser.browserRuntimeEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserRuntimeEnginePolicyId=${PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID}`,
    ),
    false,
  );
  assert.equal(
    args.some((item) => /cookie=|profile=|https?:\/\//iu.test(item)),
    false,
  );
});

void test('buildPtcSessionDockerCreateArgs projects browser navigation policy identity', () => {
  const runtimePolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: createPtcLabBrowserFixedRuntimeProbePolicy({
      maxActionMs: 1200,
    }),
  };
  const navigationPolicy = {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    network: createPtcLabOpenEgressLocalPolicy(),
    browser: createPtcLabBrowserFixedNavigationProbePolicy({
      maxActionMs: 1200,
    }),
  };
  const runtimeKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: runtimePolicy,
  });
  const navigationKey = normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace',
    policy: navigationPolicy,
  });
  const args = buildPtcSessionDockerCreateArgs({
    reuseKey: navigationKey,
    runtimeRoot: '/runtime',
  });

  assert.notEqual(navigationKey.identityHash, runtimeKey.identityHash);
  assert.equal(
    navigationKey.packageCacheIdentityHash,
    runtimeKey.packageCacheIdentityHash,
  );
  if (
    !navigationKey.browser.enabled ||
    navigationKey.browser.mode !== 'fixed_navigation_probe'
  ) {
    throw new Error('expected fixed navigation browser identity');
  }
  assert.equal(
    navigationKey.browser.browserRuntimeEnginePolicyId,
    PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  );
  assert.equal(
    navigationKey.browser.navigationTargetPolicyId,
    PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
  );
  assert.equal(
    navigationKey.browser.urlGrammarPolicyId,
    PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
  );
  assert.equal(
    navigationKey.browser.redirectPolicyId,
    PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
  );
  assert.equal(
    navigationKey.browser.evidencePolicyId,
    PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  );
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserRuntimeEnginePolicyId=${PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserNavigationTargetPolicyId=${PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserUrlGrammarPolicyId=${PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserRedirectPolicyId=${PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserEvidencePolicyId=${PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID}`,
    ),
    true,
  );
  assert.equal(
    args.includes(
      `geulbat.browserPolicyId=${PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID}`,
    ),
    false,
  );
  assert.equal(
    args.some((item) => /cookie=|profile=|https?:\/\//iu.test(item)),
    false,
  );
});
