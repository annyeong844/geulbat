import { createHash } from 'node:crypto';
import type { ParsedCanonicalArtifactEnvelope } from '@geulbat/protocol/artifacts';
import { isReactBundleRuntimeManifest } from '@geulbat/protocol/react-bundle-inline-compile';
import type {
  ReactBundleAcceptedRuntimeManifestSummary,
  ReactBundleRuntimeManifestAcceptanceResult,
} from './react-bundle-accepted-runtime-manifest.js';

export type ReactBundleAcceptedManifestArtifactCandidate =
  ParsedCanonicalArtifactEnvelope;

export type ReactBundleAcceptedRuntimeManifestSuccess = Extract<
  ReactBundleRuntimeManifestAcceptanceResult,
  { ok: true }
>;

export type ReactBundleAcceptedManifestArtifactCandidateFailureReason =
  | 'accepted_summary_invalid'
  | 'manifest_payload_invalid'
  | 'evidence_ref_not_opaque'
  | 'dependency_policy_mismatch'
  | 'payload_leaks_private_metadata';

export interface ReactBundleAcceptedManifestArtifactCandidateSuccess {
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

export function buildReactBundleAcceptedManifestArtifactCandidate(_args: {
  accepted: ReactBundleAcceptedRuntimeManifestSuccess;
}): ReactBundleAcceptedManifestArtifactCandidateResult {
  const accepted = _args.accepted as ReactBundleRuntimeManifestAcceptanceResult;
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

  if (!isOpaqueEvidenceRef(accepted.acceptance.prepareEvidenceRef)) {
    return fail(
      'evidence_ref_not_opaque',
      'react bundle accepted manifest prepare evidence ref must be opaque',
    );
  }
  if (
    accepted.acceptance.probeEvidenceRef !== undefined &&
    !isOpaqueEvidenceRef(accepted.acceptance.probeEvidenceRef)
  ) {
    return fail(
      'evidence_ref_not_opaque',
      'react bundle accepted manifest probe evidence ref must be opaque',
      {
        prepareEvidenceRef: accepted.acceptance.prepareEvidenceRef,
      },
    );
  }

  const policyValidation = validateDependencyPolicy(accepted);
  if (!policyValidation.ok) return policyValidation.failure;

  const payload = stableStringify(accepted.manifest);
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

  const artifactCandidate: ReactBundleAcceptedManifestArtifactCandidate = {
    renderer: 'react_bundle',
    payload,
    digest: `sha256:${createHash('sha256')
      .update(payload, 'utf8')
      .digest('hex')}`,
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

export type { ReactBundleAcceptedRuntimeManifestSummary as ReactBundleAcceptedManifestArtifactCandidateSource };

function validateDependencyPolicy(
  accepted: ReactBundleAcceptedRuntimeManifestSuccess,
):
  | { ok: true }
  | {
      ok: false;
      failure: ReactBundleAcceptedManifestArtifactCandidateResult;
    } {
  const evidenceCount = accepted.dependencyEvidence.length;
  if (accepted.acceptance.dependencyPolicy === 'no_runtime_dependencies') {
    if (
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
    accepted.acceptance.dependencyCount <= 0 ||
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
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

function isOpaqueEvidenceRef(value: string): boolean {
  const prefix = 'sandbox-output:';
  if (!value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  if (suffix.length === 0) return false;
  if (/[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  return (
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('.geulbat') &&
    !value.includes('..') &&
    !value.startsWith('file:')
  );
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
  accepted: ReactBundleAcceptedRuntimeManifestSuccess,
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
    isOpaqueEvidenceRef(args.prepareEvidenceRef)
  ) {
    diagnostics.prepareEvidenceRef = args.prepareEvidenceRef;
  }
  if (
    args.probeEvidenceRef !== undefined &&
    isOpaqueEvidenceRef(args.probeEvidenceRef)
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
