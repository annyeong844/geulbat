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
import { createSandboxAttemptStore } from './attempt-store.js';
import {
  acceptReactBundleRuntimeManifest,
  type ReactBundleRuntimeManifestAcceptanceResult,
} from './react-bundle-accepted-runtime-manifest.js';
import { probeReactBundleExplicitCdnDependencies } from './react-bundle-dependency-network-probe.js';
import {
  prepareReactBundleExplicitCdnDependencies,
  type ReactBundleDependencyPrepareRequest,
  type ReactBundleDependencyPrepareSummary,
} from './react-bundle-dependency-prepare.js';

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
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-accept-'));
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

async function prepareOnly(
  request = BASE_REQUEST,
): Promise<ReactBundleDependencyPrepareSummary> {
  return withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-24T00:00:00.000Z',
    });
    return prepareReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request,
      timeoutMs: 1000,
    });
  });
}

async function prepareAndProbe(request = BASE_REQUEST): Promise<{
  prepare: ReactBundleDependencyPrepareSummary;
  probe: Awaited<ReturnType<typeof probeReactBundleExplicitCdnDependencies>>;
}> {
  return withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-24T00:00:00.000Z',
    });
    const prepare = await prepareReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request,
      timeoutMs: 1000,
    });
    const probe = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request,
      timeoutMs: 1000,
      now: () => '2026-05-24T00:00:00.000Z',
      probeTransport: transport(request.dependencyRefs.map(() => 200)),
    });
    return { prepare, probe };
  });
}

function assertOk(
  result: ReactBundleRuntimeManifestAcceptanceResult,
): asserts result is Extract<
  ReactBundleRuntimeManifestAcceptanceResult,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

void test('acceptReactBundleRuntimeManifest accepts prepared manifest with matching successful probe evidence', async () => {
  const { prepare, probe } = await prepareAndProbe();

  const result = acceptReactBundleRuntimeManifest({
    prepare,
    probe,
    now: () => '2026-05-24T12:00:00.000Z',
  });

  assertOk(result);
  assert.deepEqual(result.manifest, {
    entryUrl: BASE_REQUEST.entryUrl,
    runtimeDependencies: BASE_REQUEST.runtimeDependencies,
  });
  assert.equal(result.acceptance.schemaVersion, 1);
  assert.equal(result.acceptance.acceptedAt, '2026-05-24T12:00:00.000Z');
  assert.equal(result.acceptance.source, 'explicit_cdn_prepare');
  assert.deepEqual(result.acceptance.entryUrlEvidence, {
    availability: 'not_checked',
    reason: 'runtime_smoke_deferred',
  });
  assert.equal(
    result.acceptance.dependencyPolicy,
    'metadata_probe_required_for_external_dependencies',
  );
  assert.equal(result.acceptance.prepareEvidenceRef, prepare.evidenceRef);
  assert.equal(result.acceptance.probeEvidenceRef, probe.evidenceRef);
  assert.equal(result.acceptance.dependencyCount, 2);
  assert.equal(result.acceptance.probedDependencyCount, 2);
  assert.equal(result.acceptance.unprobedDependencyCount, 0);
  assert.deepEqual(result.acceptance.networkPolicies, [
    'none',
    'allowlisted_metadata_probe',
  ]);
  assert.deepEqual(
    result.dependencyEvidence.map((dependency) => ({
      kind: dependency.kind,
      specifier: dependency.specifier ?? null,
      url: dependency.url,
      integrityStatus: dependency.integrityStatus,
      probeRequestedUrl: dependency.probe?.requestedUrl ?? null,
      probeEvidenceRef: dependency.probe?.evidenceRef ?? null,
    })),
    [
      {
        kind: 'esm_import',
        specifier:
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
        url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
        integrityStatus: 'provided_unverified',
        probeRequestedUrl:
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
        probeEvidenceRef: probe.evidenceRef,
      },
      {
        kind: 'stylesheet',
        specifier: null,
        url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
        integrityStatus: 'missing_allowed',
        probeRequestedUrl:
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
        probeEvidenceRef: probe.evidenceRef,
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /\.geulbat[\\/]+sandbox-outputs/u,
  );
});

void test('acceptReactBundleRuntimeManifest rejects external dependencies without probe evidence', async () => {
  const prepare = await prepareOnly();

  const result = acceptReactBundleRuntimeManifest({
    prepare,
    now: () => '2026-05-24T12:00:00.000Z',
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'dependency_probe_required',
    message:
      'react bundle runtime manifest dependencies require successful metadata probe evidence',
    diagnostics: {
      prepareEvidenceRef: prepare.evidenceRef,
    },
  });
});

void test('acceptReactBundleRuntimeManifest accepts no-dependency manifest without probe evidence', async () => {
  const request: ReactBundleDependencyPrepareRequest = {
    entryUrl: 'https://cdn.example.com/app.js',
    runtimeDependencies: {},
    dependencyRefs: [],
  };
  const prepare = await prepareOnly(request);

  const result = acceptReactBundleRuntimeManifest({
    prepare,
    now: () => '2026-05-24T12:00:00.000Z',
  });

  assertOk(result);
  assert.equal(result.acceptance.dependencyPolicy, 'no_runtime_dependencies');
  assert.equal(result.acceptance.probeEvidenceRef, undefined);
  assert.equal(result.acceptance.dependencyCount, 0);
  assert.equal(result.acceptance.probedDependencyCount, 0);
  assert.equal(result.acceptance.unprobedDependencyCount, 0);
  assert.deepEqual(result.acceptance.networkPolicies, ['none']);
  assert.deepEqual(result.dependencyEvidence, []);
});

void test('acceptReactBundleRuntimeManifest compares probe requested URLs instead of final URLs', async () => {
  const request: ReactBundleDependencyPrepareRequest = {
    ...BASE_REQUEST,
    runtimeDependencies: {
      importMap: {
        imports: {
          [PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER]:
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
        },
      },
    },
    dependencyRefs: [BASE_REQUEST.dependencyRefs[0]!],
  };
  const { prepare, probe } = await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-24T00:00:00.000Z',
    });
    const prepareSummary = await prepareReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request,
      timeoutMs: 1000,
    });
    const probeSummary = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request,
      timeoutMs: 1000,
      now: () => '2026-05-24T00:00:00.000Z',
      probeTransport: async (url) => {
        if (
          url.href ===
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL
        ) {
          return {
            status: 302,
            location: `${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL}?bundle`,
            contentType: null,
            contentLength: null,
            bytesRead: 0,
          };
        }
        return {
          status: 200,
          location: null,
          contentType: 'application/javascript',
          contentLength: 20,
          bytesRead: 0,
        };
      },
    });
    return { prepare: prepareSummary, probe: probeSummary };
  });

  const result = acceptReactBundleRuntimeManifest({
    prepare,
    probe,
    now: () => '2026-05-24T12:00:00.000Z',
  });

  assertOk(result);
  assert.equal(
    result.dependencyEvidence[0]?.probe?.requestedUrl,
    PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
  );
  assert.equal(
    result.dependencyEvidence[0]?.probe?.finalUrl,
    `${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL}?bundle`,
  );
});

void test('acceptReactBundleRuntimeManifest rejects probe requested URL mismatch', async () => {
  const { prepare, probe } = await prepareAndProbe();
  const result = acceptReactBundleRuntimeManifest({
    prepare,
    probe: {
      ...probe,
      dependencyProbes: probe.dependencyProbes.map((dependency, index) =>
        index === 0
          ? { ...dependency, requestedUrl: 'https://esm.sh/other@1.0.0' }
          : dependency,
      ),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.reasonCode,
    'probe_dependency_mismatch',
  );
});

void test('acceptReactBundleRuntimeManifest rejects extra prepare dependency evidence', async () => {
  const { prepare, probe } = await prepareAndProbe();
  const result = acceptReactBundleRuntimeManifest({
    prepare: {
      ...prepare,
      provenanceSummary: {
        ...prepare.provenanceSummary,
        dependencyEvidence: [
          ...prepare.provenanceSummary.dependencyEvidence,
          {
            kind: 'stylesheet',
            url: 'https://cdn.jsdelivr.net/npm/extra.css@1.0.0/extra.css',
            integrityStatus: 'missing_allowed',
          },
        ],
      },
    },
    probe,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.reasonCode,
    'dependency_evidence_mismatch',
  );
});

void test('acceptReactBundleRuntimeManifest rejects duplicate stylesheet manifest dependencies', async () => {
  const request: ReactBundleDependencyPrepareRequest = {
    entryUrl: 'https://cdn.example.com/app.js',
    runtimeDependencies: {
      stylesheets: [
        PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
        PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
      ],
    },
    dependencyRefs: [BASE_REQUEST.dependencyRefs[1]!],
  };
  const prepare = await prepareOnly(request);

  const result = acceptReactBundleRuntimeManifest({ prepare });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.reasonCode,
    'dependency_evidence_mismatch',
  );
});

void test('acceptReactBundleRuntimeManifest rejects non-opaque evidence refs', async () => {
  const { prepare, probe } = await prepareAndProbe();

  const result = acceptReactBundleRuntimeManifest({
    prepare: {
      ...prepare,
      evidenceRef: '.geulbat/sandbox-outputs/attempt/candidate.json',
    },
    probe,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.reasonCode, 'prepare_summary_invalid');
});
