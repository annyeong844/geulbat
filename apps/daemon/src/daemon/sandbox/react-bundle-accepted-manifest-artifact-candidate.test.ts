import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH,
  PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
} from '@geulbat/protocol/public-web-fixtures';
import {
  isReactBundleRuntimeManifest,
  type ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import {
  buildReactBundleAcceptedManifestArtifactCandidate,
  type ReactBundleAcceptedManifestArtifactCandidateSource,
  type ReactBundleAcceptedManifestArtifactCandidateResult,
  type ReactBundleAcceptedRuntimeManifestSuccess,
} from './react-bundle-accepted-manifest-artifact-candidate.js';

const ENTRY_URL = `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_ENTRY_PATH}`;
const EXTRA_STYLESHEET_URL =
  'https://cdn.jsdelivr.net/npm/geulbat-runtime-dependency-fixture@1.0.0/extra.css';

function acceptedWithDependencies(
  args: {
    manifest?: ReactBundleRuntimeManifest;
    acceptance?: Partial<
      ReactBundleAcceptedRuntimeManifestSuccess['acceptance']
    >;
    dependencyEvidence?: ReactBundleAcceptedRuntimeManifestSuccess['dependencyEvidence'];
  } = {},
): ReactBundleAcceptedRuntimeManifestSuccess {
  const manifest = args.manifest ?? {
    entryUrl: ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          [PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER]:
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
        },
      },
      stylesheets: [
        PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
        EXTRA_STYLESHEET_URL,
      ],
    },
  };

  return {
    ok: true,
    manifest,
    acceptance: {
      schemaVersion: 1,
      acceptedAt: '2026-05-24T12:00:00.000Z',
      source: 'explicit_cdn_prepare',
      prepareEvidenceRef: 'sandbox-output:prepare',
      probeEvidenceRef: 'sandbox-output:probe',
      entryUrlEvidence: {
        availability: 'not_checked',
        reason: 'runtime_smoke_deferred',
      },
      dependencyPolicy: 'metadata_probe_required_for_external_dependencies',
      dependencyCount: 3,
      probedDependencyCount: 3,
      unprobedDependencyCount: 0,
      networkPolicies: ['none', 'allowlisted_metadata_probe'],
      ...(args.acceptance ?? {}),
    },
    dependencyEvidence: args.dependencyEvidence ?? [
      {
        kind: 'esm_import',
        specifier:
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER,
        packageName: 'geulbat-runtime-dependency-fixture',
        version: '1.0.0',
        url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
        integrityStatus: 'provided_unverified',
        probe: {
          ok: true,
          requestedUrl:
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
          finalUrl: `${PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL}?bundle`,
          method: 'HEAD',
          status: 200,
          evidenceRef: 'sandbox-output:probe',
        },
      },
      {
        kind: 'stylesheet',
        packageName: 'geulbat-runtime-dependency-fixture',
        version: '1.0.0',
        url: PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
        integrityStatus: 'missing_allowed',
        probe: {
          ok: true,
          requestedUrl:
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
          finalUrl:
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
          method: 'HEAD',
          status: 200,
          evidenceRef: 'sandbox-output:probe',
        },
      },
      {
        kind: 'stylesheet',
        packageName: 'geulbat-runtime-dependency-fixture',
        version: '1.0.0',
        url: EXTRA_STYLESHEET_URL,
        integrityStatus: 'missing_allowed',
        probe: {
          ok: true,
          requestedUrl: EXTRA_STYLESHEET_URL,
          finalUrl: EXTRA_STYLESHEET_URL,
          method: 'HEAD',
          status: 200,
          evidenceRef: 'sandbox-output:probe',
        },
      },
    ],
  };
}

function acceptedWithoutDependencies(): ReactBundleAcceptedRuntimeManifestSuccess {
  return {
    ok: true,
    manifest: {
      entryUrl: 'https://cdn.example.com/app.js',
    },
    acceptance: {
      schemaVersion: 1,
      acceptedAt: '2026-05-24T12:00:00.000Z',
      source: 'explicit_cdn_prepare',
      prepareEvidenceRef: 'sandbox-output:prepare',
      entryUrlEvidence: {
        availability: 'not_checked',
        reason: 'runtime_smoke_deferred',
      },
      dependencyPolicy: 'no_runtime_dependencies',
      dependencyCount: 0,
      probedDependencyCount: 0,
      unprobedDependencyCount: 0,
      networkPolicies: ['none'],
    },
    dependencyEvidence: [],
  };
}

function acceptedWithBoundaryManifest(
  manifest: unknown,
): ReactBundleAcceptedManifestArtifactCandidateSource {
  const accepted = acceptedWithDependencies();
  return {
    ...accepted,
    manifest,
  };
}

function assertOk(
  result: ReactBundleAcceptedManifestArtifactCandidateResult,
): asserts result is Extract<
  ReactBundleAcceptedManifestArtifactCandidateResult,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function expectedDigest(payload: string): string {
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function buildPayload(accepted: ReactBundleAcceptedRuntimeManifestSuccess): {
  payload: string;
  digest: string | null;
} {
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted,
  });
  assertOk(result);
  return {
    payload: result.artifactCandidate.payload,
    digest: result.artifactCandidate.digest,
  };
}

function assertFailure(
  result: ReactBundleAcceptedManifestArtifactCandidateResult,
  reasonCode: Exclude<
    ReactBundleAcceptedManifestArtifactCandidateResult,
    { ok: true }
  >['reasonCode'],
): asserts result is Exclude<
  ReactBundleAcceptedManifestArtifactCandidateResult,
  { ok: true }
> {
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, reasonCode);
}

function withoutProbeEvidenceRef(
  accepted: ReactBundleAcceptedRuntimeManifestSuccess,
): ReactBundleAcceptedRuntimeManifestSuccess {
  const { probeEvidenceRef: _probeEvidenceRef, ...acceptance } =
    accepted.acceptance;
  return {
    ...accepted,
    acceptance,
  };
}

void test('buildReactBundleAcceptedManifestArtifactCandidate creates a react_bundle candidate from an accepted manifest', () => {
  const accepted = acceptedWithDependencies();

  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted,
  });

  assertOk(result);
  assert.equal(result.artifactCandidate.renderer, 'react_bundle');
  assert.equal(
    result.artifactCandidate.digest,
    expectedDigest(result.artifactCandidate.payload),
  );
  const parsed = JSON.parse(result.artifactCandidate.payload) as unknown;
  assert.equal(isReactBundleRuntimeManifest(parsed), true);
  assert.deepEqual(parsed, accepted.manifest);
  assert.deepEqual(result.handoff, {
    schemaVersion: 1,
    source: 'accepted_runtime_manifest',
    acceptedAt: '2026-05-24T12:00:00.000Z',
    prepareEvidenceRef: 'sandbox-output:prepare',
    probeEvidenceRef: 'sandbox-output:probe',
    entryUrlEvidence: {
      availability: 'not_checked',
      reason: 'runtime_smoke_deferred',
    },
    dependencyCount: 3,
    dependencyPolicy: 'metadata_probe_required_for_external_dependencies',
  });
});

void test('buildReactBundleAcceptedManifestArtifactCandidate keeps evidence metadata out of the payload', () => {
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: acceptedWithDependencies(),
  });

  assertOk(result);
  for (const marker of [
    'prepareEvidenceRef',
    'probeEvidenceRef',
    'dependencyEvidence',
    'sandbox-output:',
    '.geulbat/',
    '.geulbat\\',
    'attemptId',
    'attempt-',
  ]) {
    assert.equal(
      result.artifactCandidate.payload.includes(marker),
      false,
      `payload should not contain ${marker}`,
    );
  }
});

void test('buildReactBundleAcceptedManifestArtifactCandidate allows ordinary manifest strings that resemble broad private markers', () => {
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: acceptedWithDependencies({
      manifest: {
        entryUrl: 'https://cdn.example.com/attempt-entry.js',
        runtimeDependencies:
          acceptedWithDependencies().manifest.runtimeDependencies!,
      },
    }),
  });

  assertOk(result);
  assert.match(result.artifactCandidate.payload, /attempt-entry/u);
});

void test('buildReactBundleAcceptedManifestArtifactCandidate uses deterministic payload identity for equivalent manifest key order', () => {
  const first = acceptedWithDependencies();
  const second = acceptedWithDependencies({
    manifest: {
      runtimeDependencies: first.manifest.runtimeDependencies!,
      entryUrl: first.manifest.entryUrl,
    },
  });

  assert.deepEqual(buildPayload(first), buildPayload(second));
});

void test('buildReactBundleAcceptedManifestArtifactCandidate preserves stylesheet array order in payload identity', () => {
  const accepted = acceptedWithDependencies();
  const reversed = acceptedWithDependencies({
    manifest: {
      entryUrl: accepted.manifest.entryUrl,
      runtimeDependencies: {
        importMap: accepted.manifest.runtimeDependencies!.importMap!,
        stylesheets: [
          EXTRA_STYLESHEET_URL,
          PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_STYLESHEET_URL,
        ],
      },
    },
  });

  assert.notDeepEqual(buildPayload(accepted), buildPayload(reversed));
});

void test('buildReactBundleAcceptedManifestArtifactCandidate accepts no-dependency summaries without probe evidence', () => {
  const accepted = acceptedWithoutDependencies();

  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted,
  });

  assertOk(result);
  assert.equal(result.artifactCandidate.renderer, 'react_bundle');
  assert.equal(
    result.artifactCandidate.digest,
    expectedDigest(result.artifactCandidate.payload),
  );
  assert.deepEqual(JSON.parse(result.artifactCandidate.payload), {
    entryUrl: 'https://cdn.example.com/app.js',
  });
  assert.deepEqual(result.handoff, {
    schemaVersion: 1,
    source: 'accepted_runtime_manifest',
    acceptedAt: '2026-05-24T12:00:00.000Z',
    prepareEvidenceRef: 'sandbox-output:prepare',
    entryUrlEvidence: {
      availability: 'not_checked',
      reason: 'runtime_smoke_deferred',
    },
    dependencyCount: 0,
    dependencyPolicy: 'no_runtime_dependencies',
  });
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects dependency summaries missing probe evidence', () => {
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: withoutProbeEvidenceRef(acceptedWithDependencies()),
  });

  assertFailure(result, 'dependency_policy_mismatch');
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects inconsistent dependency probe counts', () => {
  const accepted = acceptedWithDependencies({
    acceptance: {
      probedDependencyCount: 2,
    },
  });

  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted,
  });

  assertFailure(result, 'dependency_policy_mismatch');
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects inconsistent network policy projection', () => {
  const accepted = acceptedWithDependencies({
    acceptance: {
      networkPolicies: ['allowlisted_metadata_probe', 'none'],
    },
  });

  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted,
  });

  assertFailure(result, 'dependency_policy_mismatch');
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects no-dependency summaries with probe policy residue', () => {
  const accepted = acceptedWithoutDependencies();
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: {
      ...accepted,
      acceptance: {
        ...accepted.acceptance,
        probedDependencyCount: 1,
        networkPolicies: ['none', 'allowlisted_metadata_probe'],
      },
    },
  });

  assertFailure(result, 'dependency_policy_mismatch');
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects malformed opaque evidence refs', () => {
  for (const prepareEvidenceRef of [
    'sandbox-output:',
    'sandbox-output:with space',
    'sandbox-output:with\nnewline',
    'sandbox-output:../escape',
    'sandbox-output:path/segment',
    'sandbox-output:path\\segment',
    'sandbox-output:.geulbat',
    'file:evidence',
  ]) {
    const result = buildReactBundleAcceptedManifestArtifactCandidate({
      accepted: acceptedWithDependencies({
        acceptance: {
          prepareEvidenceRef,
        },
      }),
    });

    assertFailure(result, 'evidence_ref_not_opaque');
  }
});

void test('buildReactBundleAcceptedManifestArtifactCandidate does not leak non-opaque refs in failure diagnostics', () => {
  const accepted = acceptedWithDependencies();
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: {
      ...accepted,
      acceptance: {
        ...accepted.acceptance,
        source: 'unexpected' as 'explicit_cdn_prepare',
        prepareEvidenceRef: '.geulbat/sandbox-outputs/attempt/candidate.json',
      },
    },
  });

  assertFailure(result, 'accepted_summary_invalid');
  assert.doesNotMatch(JSON.stringify(result), /\.geulbat/u);
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects private metadata leaks in manifest payload', () => {
  const accepted = acceptedWithBoundaryManifest({
    entryUrl: ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          [PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_IMPORT_SPECIFIER]:
            PUBLIC_WEB_REACT_BUNDLE_RUNTIME_DEPENDENCIES_CDN_MODULE_URL,
        },
      },
    },
    prepareEvidenceRef: 'sandbox-output:payload-leak',
  });

  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted,
  });

  assertFailure(result, 'payload_leaks_private_metadata');
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects malformed accepted summaries at runtime', () => {
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: {
      ok: false,
      reasonCode: 'probe_policy_failed',
      message: 'not accepted',
    },
  });

  assertFailure(result, 'accepted_summary_invalid');
});

void test('buildReactBundleAcceptedManifestArtifactCandidate rejects payloads that do not parse as protocol runtime manifests', () => {
  const result = buildReactBundleAcceptedManifestArtifactCandidate({
    accepted: acceptedWithBoundaryManifest({
      entryUrl: ENTRY_URL,
      runtimeDependencies: {
        importMap: 'invalid',
      },
    }),
  });

  assertFailure(result, 'manifest_payload_invalid');
});
