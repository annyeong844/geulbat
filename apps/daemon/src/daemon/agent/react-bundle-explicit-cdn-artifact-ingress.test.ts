import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
} from '@geulbat/protocol/public-web-fixtures';
import type { HttpMetadataProbeRequestTransport } from '../network/http-metadata-probe.js';
import { createSandboxAttemptStore } from '../sandbox/attempt-store.js';
import type {
  ReactBundleAcceptedManifestArtifactCandidateSource,
  ReactBundleAcceptedManifestArtifactCandidateResult,
} from '../sandbox/react-bundle-accepted-manifest-artifact-candidate.js';
import type { ReactBundleRuntimeManifestAcceptanceResult } from '../sandbox/react-bundle-accepted-runtime-manifest.js';
import type { ReactBundleDependencyPrepareRequest } from '../sandbox/react-bundle-dependency-prepare.js';
import {
  runReactBundleExplicitCdnArtifactIngress,
  type ReactBundleExplicitCdnArtifactIngressResult,
} from './react-bundle-explicit-cdn-artifact-ingress.js';

const BASE_REQUEST: ReactBundleDependencyPrepareRequest = {
  entryUrl: `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH}`,
  runtimeDependencies: {
    importMap: {
      imports: {
        [PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER]:
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
      },
    },
    stylesheets: [
      PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
    ],
  },
  dependencyRefs: [
    {
      kind: 'esm_import',
      specifier: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
      packageName: 'geulbat-runtime-dependency-fixture',
      version: '1.0.0',
      provider: 'explicit_cdn',
      url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
      integrity: 'sha384-fixture',
    },
    {
      kind: 'stylesheet',
      packageName: 'geulbat-runtime-dependency-fixture',
      version: '1.0.0',
      provider: 'explicit_cdn',
      url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
    },
  ],
};

async function withWorkspace<T>(
  fn: (workspaceRoot: string) => Promise<T>,
): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-ingress-'));
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function transport(statuses: number[]): HttpMetadataProbeRequestTransport {
  let index = 0;
  return async (_url, options) => {
    const status = statuses[index++] ?? 200;
    return {
      status,
      location: null,
      contentType:
        options.method === 'HEAD' ? 'application/javascript' : 'text/plain',
      contentLength: 20,
      bytesRead: options.method === 'GET' ? 4 : 0,
    };
  };
}

function assertOk(
  result: ReactBundleExplicitCdnArtifactIngressResult,
): asserts result is Extract<
  ReactBundleExplicitCdnArtifactIngressResult,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function assertFailure(
  result: ReactBundleExplicitCdnArtifactIngressResult,
  reasonCode: Exclude<
    ReactBundleExplicitCdnArtifactIngressResult,
    { ok: true }
  >['reasonCode'],
): asserts result is Exclude<
  ReactBundleExplicitCdnArtifactIngressResult,
  { ok: true }
> {
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, reasonCode);
}

void test('runReactBundleExplicitCdnArtifactIngress returns an artifact AgentResult after the full explicit CDN chain', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-25T00:00:00.000Z',
    });

    const result = await runReactBundleExplicitCdnArtifactIngress({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1000,
      now: () => '2026-05-25T12:00:00.000Z',
      probeTransport: transport(BASE_REQUEST.dependencyRefs.map(() => 200)),
    });

    assertOk(result);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.finalProse, '');
    assert.equal(result.result.artifactCandidate?.renderer, 'react_bundle');
    assert.deepEqual(JSON.parse(result.result.artifactCandidate!.payload), {
      entryUrl: BASE_REQUEST.entryUrl,
      runtimeDependencies: BASE_REQUEST.runtimeDependencies,
    });
    assert.equal(
      result.accepted.acceptance.dependencyPolicy,
      'metadata_probe_required_for_external_dependencies',
    );
    assert.equal(
      result.accepted.acceptance.prepareEvidenceRef.startsWith(
        'sandbox-output:',
      ),
      true,
    );
    assert.equal(
      result.accepted.acceptance.probeEvidenceRef?.startsWith(
        'sandbox-output:',
      ),
      true,
    );
    assert.equal(result.handoff.source, 'accepted_runtime_manifest');
    assert.equal(result.handoff.dependencyCount, 2);

    const attempts = store.getAttempts().records;
    assert.deepEqual(
      attempts.map((attempt) => ({
        jobKind: attempt.jobKind,
        adapterKind: attempt.adapterKind,
        status: attempt.status,
        hasOutputRef: attempt.outputRef !== null,
      })),
      [
        {
          jobKind: 'react_bundle_dependency_prepare',
          adapterKind: 'react_bundle_explicit_cdn_dependency_prepare',
          status: 'succeeded',
          hasOutputRef: true,
        },
        {
          jobKind: 'react_bundle_dependency_network_probe',
          adapterKind: 'react_bundle_dependency_metadata_probe',
          status: 'succeeded',
          hasOutputRef: true,
        },
      ],
    );
  });
});

void test('runReactBundleExplicitCdnArtifactIngress accepts no-dependency requests with required empty dependencyRefs', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-25T00:00:00.000Z',
    });

    const result = await runReactBundleExplicitCdnArtifactIngress({
      workspaceRoot,
      store,
      request: {
        entryUrl: 'https://fixtures.geulbat.local/no-deps.js',
        runtimeDependencies: {},
        dependencyRefs: [],
      },
      timeoutMs: 1000,
      now: () => '2026-05-25T12:00:00.000Z',
      probeTransport: async () => {
        throw new Error('no-dependency ingress should not probe metadata');
      },
    });

    assertOk(result);
    assert.equal(
      result.accepted.acceptance.dependencyPolicy,
      'no_runtime_dependencies',
    );
    assert.equal(result.accepted.acceptance.probeEvidenceRef, undefined);
    assert.equal(result.result.finalProse, '');
    assert.equal(result.result.artifactCandidate?.renderer, 'react_bundle');

    assert.deepEqual(
      store.getAttempts().records.map((attempt) => attempt.jobKind),
      ['react_bundle_dependency_prepare'],
    );
  });
});

void test('runReactBundleExplicitCdnArtifactIngress rejects dependency-bearing requests without provenance', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore();

    const result = await runReactBundleExplicitCdnArtifactIngress({
      workspaceRoot,
      store,
      request: {
        ...BASE_REQUEST,
        dependencyRefs: [],
      },
      timeoutMs: 1000,
      probeTransport: transport([200, 200]),
    });

    assertFailure(result, 'prepare_failed');
    assert.equal(store.getAttempts().records.length, 0);
  });
});

void test('runReactBundleExplicitCdnArtifactIngress classifies failed metadata probes', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore();

    const result = await runReactBundleExplicitCdnArtifactIngress({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1000,
      probeTransport: transport([200, 404]),
    });

    assertFailure(result, 'probe_failed');
    assert.equal(JSON.stringify(result).includes('.geulbat'), false);
    assert.equal(
      store
        .getAttempts()
        .records.some(
          (attempt) =>
            attempt.jobKind === 'react_bundle_dependency_network_probe',
        ),
      true,
    );
  });
});

void test('runReactBundleExplicitCdnArtifactIngress preserves acceptance failure stage without leaking path refs', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore();

    const result = await runReactBundleExplicitCdnArtifactIngress({
      workspaceRoot,
      store,
      request: {
        entryUrl: 'https://fixtures.geulbat.local/no-deps.js',
        runtimeDependencies: {},
        dependencyRefs: [],
      },
      timeoutMs: 1000,
      acceptRuntimeManifest: () =>
        ({
          ok: false,
          reasonCode: 'prepare_summary_invalid',
          message: 'synthetic acceptance failure',
          diagnostics: {
            prepareEvidenceRef: '.geulbat/sandbox-outputs/private',
          },
        }) satisfies ReactBundleRuntimeManifestAcceptanceResult,
    });

    assertFailure(result, 'acceptance_failed');
    assert.equal(JSON.stringify(result).includes('.geulbat'), false);
  });
});

void test('runReactBundleExplicitCdnArtifactIngress preserves artifact candidate failure stage', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore();

    const result = await runReactBundleExplicitCdnArtifactIngress({
      workspaceRoot,
      store,
      request: {
        entryUrl: 'https://fixtures.geulbat.local/no-deps.js',
        runtimeDependencies: {},
        dependencyRefs: [],
      },
      timeoutMs: 1000,
      buildArtifactCandidate: (_args: {
        accepted: ReactBundleAcceptedManifestArtifactCandidateSource;
      }): ReactBundleAcceptedManifestArtifactCandidateResult => ({
        ok: false,
        reasonCode: 'manifest_payload_invalid',
        message: 'synthetic candidate failure',
      }),
    });

    assertFailure(result, 'artifact_candidate_failed');
    assert.equal('result' in result, false);
  });
});
