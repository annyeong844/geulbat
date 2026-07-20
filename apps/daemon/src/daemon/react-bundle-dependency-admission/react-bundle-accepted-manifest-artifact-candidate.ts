import type { ParsedCanonicalArtifactEnvelope } from '@geulbat/protocol/artifacts';
import {
  isReactBundleRuntimeManifest,
  type ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { isReactBundleDependencyRecord as isRecord } from './react-bundle-dependency-value-guards.js';
import { sha256Digest } from '@geulbat/content-identity/sha256';
import { stableStringify } from '@geulbat/content-identity/stable-json';
import type { ReactBundleRuntimeManifestAcceptanceResult } from './react-bundle-accepted-runtime-manifest.js';
import { normalizeDependencyUrl } from './react-bundle-dependency-prepare.js';
import { isOpaqueSandboxOutputEvidenceRef } from '../sandbox/output-validation.js';

type ReactBundleAcceptedManifestArtifactCandidate =
  ParsedCanonicalArtifactEnvelope;

export type ReactBundleAcceptedRuntimeManifestSuccess = Extract<
  ReactBundleRuntimeManifestAcceptanceResult,
  { ok: true }
>;

type ReactBundleAcceptedRuntimeManifestFailure = Extract<
  ReactBundleRuntimeManifestAcceptanceResult,
  { ok: false }
>;

type ReactBundleAcceptedRuntimeManifestBoundarySuccess = Omit<
  ReactBundleAcceptedRuntimeManifestSuccess,
  'manifest'
> & {
  manifest: unknown;
};

export type ReactBundleAcceptedManifestArtifactCandidateSource =
  | ReactBundleAcceptedRuntimeManifestBoundarySuccess
  | ReactBundleAcceptedRuntimeManifestFailure;

type ReactBundleAcceptedManifestArtifactCandidateFailureReason =
  | 'accepted_summary_invalid'
  | 'manifest_payload_invalid'
  | 'evidence_ref_not_opaque'
  | 'dependency_policy_mismatch'
  | 'payload_leaks_private_metadata';

interface ReactBundleAcceptedManifestArtifactCandidateSuccess {
  ok: true;
  artifactCandidate: ReactBundleAcceptedManifestArtifactCandidate;
  handoff: {
    schemaVersion: 1;
    source: 'accepted_runtime_manifest';
    acceptedAt: string;
    prepareEvidenceRef: string;
    probeEvidenceRef?: string;
    entryUrlEvidence: {
      availability: 'not_checked';
      reason: 'runtime_smoke_deferred';
    };
    dependencyCount: number;
    dependencyPolicy:
      | 'no_runtime_dependencies'
      | 'metadata_probe_required_for_external_dependencies';
  };
}

export type ReactBundleAcceptedManifestArtifactCandidateResult =
  | ReactBundleAcceptedManifestArtifactCandidateSuccess
  | {
      ok: false;
      reasonCode: ReactBundleAcceptedManifestArtifactCandidateFailureReason;
      message: string;
      diagnostics?: {
        prepareEvidenceRef?: string;
        probeEvidenceRef?: string;
      };
    };

type FailureDiagnostics = Extract<
  ReactBundleAcceptedManifestArtifactCandidateResult,
  { ok: false }
>['diagnostics'];

export function buildReactBundleAcceptedManifestArtifactCandidate(args: {
  accepted: ReactBundleAcceptedManifestArtifactCandidateSource;
}): ReactBundleAcceptedManifestArtifactCandidateResult {
  const { accepted } = args;
  if (accepted.ok !== true) {
    return fail(
      'accepted_summary_invalid',
      'react bundle artifact candidate handoff requires an accepted runtime manifest summary',
    );
  }

  if (
    accepted.acceptance.schemaVersion !== 1 ||
    accepted.acceptance.source !== 'explicit_cdn_prepare' ||
    accepted.acceptance.entryUrlEvidence.availability !== 'not_checked' ||
    accepted.acceptance.entryUrlEvidence.reason !== 'runtime_smoke_deferred'
  ) {
    return fail(
      'accepted_summary_invalid',
      'react bundle accepted runtime manifest summary has unsupported acceptance metadata',
      safeEvidenceDiagnostics({
        prepareEvidenceRef: accepted.acceptance.prepareEvidenceRef,
        probeEvidenceRef: accepted.acceptance.probeEvidenceRef,
      }),
    );
  }

  if (
    !isOpaqueSandboxOutputEvidenceRef(accepted.acceptance.prepareEvidenceRef)
  ) {
    return fail(
      'evidence_ref_not_opaque',
      'react bundle accepted manifest prepare evidence ref must be opaque',
    );
  }
  if (
    accepted.acceptance.probeEvidenceRef !== undefined &&
    !isOpaqueSandboxOutputEvidenceRef(accepted.acceptance.probeEvidenceRef)
  ) {
    return fail(
      'evidence_ref_not_opaque',
      'react bundle accepted manifest probe evidence ref must be opaque',
      {
        prepareEvidenceRef: accepted.acceptance.prepareEvidenceRef,
      },
    );
  }

  const payload = stableStringify(accepted.manifest, {
    omitUndefinedObjectKeys: true,
  });
  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    return fail(
      'manifest_payload_invalid',
      'react bundle artifact candidate payload must parse as a runtime manifest',
      evidenceDiagnostics(accepted),
    );
  }

  if (containsPrivateMetadata(parsed.value)) {
    return fail(
      'payload_leaks_private_metadata',
      'react bundle artifact candidate payload must contain only the raw runtime manifest',
      evidenceDiagnostics(accepted),
    );
  }

  if (!isReactBundleRuntimeManifest(parsed.value)) {
    return fail(
      'manifest_payload_invalid',
      'react bundle artifact candidate payload must parse as a runtime manifest',
      evidenceDiagnostics(accepted),
    );
  }

  const policyValidation = validateDependencyPolicy(accepted, parsed.value);
  if (!policyValidation.ok) {
    return policyValidation.failure;
  }

  const artifactCandidate: ReactBundleAcceptedManifestArtifactCandidate = {
    renderer: 'react_bundle',
    payload,
    digest: sha256Digest(payload),
  };

  return {
    ok: true,
    artifactCandidate,
    handoff: {
      schemaVersion: 1,
      source: 'accepted_runtime_manifest',
      acceptedAt: accepted.acceptance.acceptedAt,
      prepareEvidenceRef: accepted.acceptance.prepareEvidenceRef,
      ...(accepted.acceptance.probeEvidenceRef
        ? { probeEvidenceRef: accepted.acceptance.probeEvidenceRef }
        : {}),
      entryUrlEvidence: accepted.acceptance.entryUrlEvidence,
      dependencyCount: accepted.acceptance.dependencyCount,
      dependencyPolicy: accepted.acceptance.dependencyPolicy,
    },
  };
}

function validateDependencyPolicy(
  accepted: ReactBundleAcceptedRuntimeManifestBoundarySuccess,
  manifest: ReactBundleRuntimeManifest,
):
  | { ok: true }
  | {
      ok: false;
      failure: ReactBundleAcceptedManifestArtifactCandidateResult;
    } {
  const manifestKeys = collectManifestDependencyKeys(manifest);
  const evidenceKeys = collectEvidenceDependencyKeys(accepted);
  const evidenceCount = accepted.dependencyEvidence.length;
  if (!manifestKeys.ok || !evidenceKeys.ok) {
    return {
      ok: false,
      failure: fail(
        'dependency_policy_mismatch',
        'react bundle dependency artifact handoff summary has inconsistent dependency URLs',
        evidenceDiagnostics(accepted),
      ),
    };
  }
  if (accepted.acceptance.dependencyPolicy === 'no_runtime_dependencies') {
    if (
      manifestKeys.value.length !== 0 ||
      accepted.acceptance.dependencyCount !== 0 ||
      accepted.acceptance.probedDependencyCount !== 0 ||
      accepted.acceptance.unprobedDependencyCount !== 0 ||
      evidenceCount !== 0 ||
      accepted.acceptance.probeEvidenceRef !== undefined ||
      !sameStringArray(accepted.acceptance.networkPolicies, ['none'])
    ) {
      return {
        ok: false,
        failure: fail(
          'dependency_policy_mismatch',
          'react bundle no-dependency artifact handoff summary has dependency evidence',
          evidenceDiagnostics(accepted),
        ),
      };
    }
    return { ok: true };
  }

  if (
    !sameStringArray(manifestKeys.value, evidenceKeys.value) ||
    accepted.acceptance.dependencyCount <= 0 ||
    manifestKeys.value.length !== accepted.acceptance.dependencyCount ||
    evidenceCount !== accepted.acceptance.dependencyCount ||
    accepted.acceptance.probedDependencyCount !==
      accepted.acceptance.dependencyCount ||
    accepted.acceptance.unprobedDependencyCount !== 0 ||
    accepted.acceptance.probeEvidenceRef === undefined ||
    !sameStringArray(accepted.acceptance.networkPolicies, [
      'none',
      'allowlisted_metadata_probe',
    ])
  ) {
    return {
      ok: false,
      failure: fail(
        'dependency_policy_mismatch',
        'react bundle dependency artifact handoff summary has inconsistent probe evidence',
        evidenceDiagnostics(accepted),
      ),
    };
  }
  return { ok: true };
}

function collectManifestDependencyKeys(
  manifest: ReactBundleRuntimeManifest,
): { ok: true; value: string[] } | { ok: false } {
  const keys: string[] = [];
  try {
    for (const [specifier, url] of Object.entries(
      manifest.runtimeDependencies?.importMap?.imports ?? {},
    )) {
      keys.push(
        dependencyKey('esm_import', normalizeDependencyUrl(url), specifier),
      );
    }
    for (const url of manifest.runtimeDependencies?.stylesheets ?? []) {
      keys.push(dependencyKey('stylesheet', normalizeDependencyUrl(url)));
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, value: keys.sort() };
}

function collectEvidenceDependencyKeys(
  accepted: ReactBundleAcceptedRuntimeManifestBoundarySuccess,
): { ok: true; value: string[] } | { ok: false } {
  const keys: string[] = [];
  try {
    for (const evidence of accepted.dependencyEvidence) {
      if (evidence.kind === 'esm_import') {
        keys.push(
          dependencyKey(
            'esm_import',
            normalizeDependencyUrl(evidence.url),
            evidence.specifier,
          ),
        );
      } else {
        keys.push(
          dependencyKey('stylesheet', normalizeDependencyUrl(evidence.url)),
        );
      }
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, value: keys.sort() };
}

function dependencyKey(
  kind: 'esm_import' | 'stylesheet',
  url: string,
  specifier?: string,
): string {
  return kind === 'esm_import'
    ? `${kind}:${specifier ?? ''}:${url}`
    : `${kind}:${url}`;
}

function parsePayload(
  payload: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch {
    return { ok: false };
  }
}

function containsPrivateMetadata(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      value.includes('sandbox-output:') ||
      value.includes('.geulbat/') ||
      value.includes('.geulbat\\')
    );
  }
  if (Array.isArray(value)) {
    return value.some(containsPrivateMetadata);
  }
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, nested]) =>
        [
          'prepareEvidenceRef',
          'probeEvidenceRef',
          'dependencyEvidence',
          'attemptId',
        ].includes(key) || containsPrivateMetadata(nested),
    );
  }
  return false;
}

function sameStringArray(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function evidenceDiagnostics(
  accepted: ReactBundleAcceptedRuntimeManifestBoundarySuccess,
): FailureDiagnostics {
  return safeEvidenceDiagnostics({
    prepareEvidenceRef: accepted.acceptance.prepareEvidenceRef,
    probeEvidenceRef: accepted.acceptance.probeEvidenceRef,
  });
}

function safeEvidenceDiagnostics(args: {
  prepareEvidenceRef?: string | undefined;
  probeEvidenceRef?: string | undefined;
}): FailureDiagnostics {
  const diagnostics: NonNullable<FailureDiagnostics> = {};
  if (
    args.prepareEvidenceRef !== undefined &&
    isOpaqueSandboxOutputEvidenceRef(args.prepareEvidenceRef)
  ) {
    diagnostics.prepareEvidenceRef = args.prepareEvidenceRef;
  }
  if (
    args.probeEvidenceRef !== undefined &&
    isOpaqueSandboxOutputEvidenceRef(args.probeEvidenceRef)
  ) {
    diagnostics.probeEvidenceRef = args.probeEvidenceRef;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function fail(
  reasonCode: ReactBundleAcceptedManifestArtifactCandidateFailureReason,
  message: string,
  diagnostics?: FailureDiagnostics,
): Extract<ReactBundleAcceptedManifestArtifactCandidateResult, { ok: false }> {
  return {
    ok: false,
    reasonCode,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
