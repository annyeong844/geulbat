import type { ReactBundleRuntimeManifest } from '@geulbat/protocol/react-bundle-inline-compile';
import {
  normalizeDependencyUrl,
  normalizeReactBundleEntryUrl,
  type ReactBundleDependencyPrepareSummary,
  type ReactBundleRuntimeDependencies,
} from './react-bundle-dependency-prepare.js';
import type {
  ReactBundleDependencyNetworkProbeSummary,
  ReactBundleDependencyNetworkProbeSummaryProbe,
} from './react-bundle-dependency-network-probe.js';
import { isOpaqueSandboxOutputEvidenceRef } from '../sandbox/output-validation.js';

export type ReactBundleRuntimeManifestAcceptanceFailureReason =
  | 'prepare_summary_invalid'
  | 'manifest_entry_url_invalid'
  | 'dependency_evidence_mismatch'
  | 'dependency_probe_required'
  | 'probe_summary_invalid'
  | 'probe_dependency_mismatch'
  | 'probe_policy_failed';

export type ReactBundleRuntimeManifestDependencyPolicy =
  | 'no_runtime_dependencies'
  | 'metadata_probe_required_for_external_dependencies';

type AcceptedRuntimeManifestNetworkPolicy =
  | 'none'
  | 'allowlisted_metadata_probe';

export interface ReactBundleAcceptedRuntimeManifestDependencyEvidence {
  kind: 'esm_import' | 'stylesheet';
  specifier?: string;
  packageName?: string;
  version?: string;
  url: string;
  integrityStatus: 'provided_unverified' | 'missing_allowed';
  probe?: {
    ok: true;
    requestedUrl: string;
    finalUrl: string;
    method: 'HEAD' | 'GET';
    status: number;
    evidenceRef: string;
  };
}

export interface ReactBundleAcceptedRuntimeManifestSummary {
  ok: true;
  manifest: ReactBundleRuntimeManifest;
  acceptance: {
    schemaVersion: 1;
    acceptedAt: string;
    source: 'explicit_cdn_prepare';
    prepareEvidenceRef: string;
    probeEvidenceRef?: string;
    entryUrlEvidence: {
      availability: 'not_checked';
      reason: 'runtime_smoke_deferred';
    };
    dependencyPolicy: ReactBundleRuntimeManifestDependencyPolicy;
    dependencyCount: number;
    probedDependencyCount: number;
    unprobedDependencyCount: number;
    networkPolicies: AcceptedRuntimeManifestNetworkPolicy[];
  };
  dependencyEvidence: ReactBundleAcceptedRuntimeManifestDependencyEvidence[];
}

export type ReactBundleRuntimeManifestAcceptanceResult =
  | ReactBundleAcceptedRuntimeManifestSummary
  | {
      ok: false;
      reasonCode: ReactBundleRuntimeManifestAcceptanceFailureReason;
      message: string;
      diagnostics?: {
        prepareEvidenceRef?: string;
        probeEvidenceRef?: string;
        dependencyUrl?: string;
      };
    };

type ManifestDependency = {
  key: string;
  kind: 'esm_import' | 'stylesheet';
  specifier?: string;
  url: string;
};

type PreparedDependencyEvidence =
  ReactBundleDependencyPrepareSummary['provenanceSummary']['dependencyEvidence'][number];

type ValidatedProbeSummary = {
  evidenceRef: string;
  probesByKey: Map<
    string,
    Extract<ReactBundleDependencyNetworkProbeSummaryProbe, { ok: true }>
  >;
};

type FailureDiagnostics = Extract<
  ReactBundleRuntimeManifestAcceptanceResult,
  { ok: false }
>['diagnostics'];

export function acceptReactBundleRuntimeManifest(args: {
  prepare: ReactBundleDependencyPrepareSummary;
  probe?: ReactBundleDependencyNetworkProbeSummary;
  now?: () => string;
}): ReactBundleRuntimeManifestAcceptanceResult {
  const prepareValidation = validatePrepareSummary(args.prepare);
  if (!prepareValidation.ok) return prepareValidation.failure;

  try {
    normalizeReactBundleEntryUrl(args.prepare.manifest.entryUrl);
  } catch {
    return fail(
      'manifest_entry_url_invalid',
      'react bundle runtime manifest entryUrl is not admitted by runtime URL policy',
      { prepareEvidenceRef: args.prepare.evidenceRef },
    );
  }

  const manifestDependencies = collectManifestDependencies({
    dependencies: args.prepare.manifest.runtimeDependencies,
    prepareEvidenceRef: args.prepare.evidenceRef,
  });
  if (!manifestDependencies.ok) return manifestDependencies.failure;

  const preparedEvidence = collectPreparedDependencyEvidence({
    evidence: args.prepare.provenanceSummary.dependencyEvidence,
    manifestDependencies: manifestDependencies.dependencies,
    prepareEvidenceRef: args.prepare.evidenceRef,
  });
  if (!preparedEvidence.ok) return preparedEvidence.failure;

  if (manifestDependencies.dependencies.length === 0) {
    return buildSuccess({
      prepare: args.prepare,
      manifestDependencies: [],
      preparedEvidenceByKey: preparedEvidence.evidenceByKey,
      dependencyPolicy: 'no_runtime_dependencies',
      acceptedAt: (args.now ?? (() => new Date().toISOString()))(),
    });
  }

  if (!args.probe) {
    return fail(
      'dependency_probe_required',
      'react bundle runtime manifest dependencies require successful metadata probe evidence',
      { prepareEvidenceRef: args.prepare.evidenceRef },
    );
  }

  const probeValidation = validateProbeSummary({
    probe: args.probe,
    manifestDependencies: manifestDependencies.dependencies,
    prepareEvidenceRef: args.prepare.evidenceRef,
  });
  if (!probeValidation.ok) return probeValidation.failure;

  return buildSuccess({
    prepare: args.prepare,
    probe: args.probe,
    manifestDependencies: manifestDependencies.dependencies,
    preparedEvidenceByKey: preparedEvidence.evidenceByKey,
    probesByKey: probeValidation.probesByKey,
    dependencyPolicy: 'metadata_probe_required_for_external_dependencies',
    acceptedAt: (args.now ?? (() => new Date().toISOString()))(),
  });
}

function validatePrepareSummary(
  prepare: ReactBundleDependencyPrepareSummary,
):
  | { ok: true }
  | { ok: false; failure: ReactBundleRuntimeManifestAcceptanceResult } {
  if (!isOpaqueSandboxOutputEvidenceRef(prepare.evidenceRef)) {
    return {
      ok: false,
      failure: fail(
        'prepare_summary_invalid',
        'react bundle prepare evidence ref must be opaque',
      ),
    };
  }
  return { ok: true };
}

function collectManifestDependencies(args: {
  dependencies: ReactBundleRuntimeDependencies | undefined;
  prepareEvidenceRef: string;
}):
  | { ok: true; dependencies: ManifestDependency[] }
  | { ok: false; failure: ReactBundleRuntimeManifestAcceptanceResult } {
  const dependencies = args.dependencies ?? {};
  const manifestDependencies: ManifestDependency[] = [];

  for (const [specifier, url] of Object.entries(
    dependencies.importMap?.imports ?? {},
  )) {
    const normalized = tryNormalizeUrl(url);
    if (!normalized.ok) {
      return {
        ok: false,
        failure: fail(
          'dependency_evidence_mismatch',
          'react bundle import-map dependency URL is not a valid absolute URL',
          { prepareEvidenceRef: args.prepareEvidenceRef, dependencyUrl: url },
        ),
      };
    }
    manifestDependencies.push({
      key: dependencyKey('esm_import', normalized.url, specifier),
      kind: 'esm_import',
      specifier,
      url: normalized.url,
    });
  }

  const stylesheetUrls = new Set<string>();
  for (const url of dependencies.stylesheets ?? []) {
    const normalized = tryNormalizeUrl(url);
    if (!normalized.ok) {
      return {
        ok: false,
        failure: fail(
          'dependency_evidence_mismatch',
          'react bundle stylesheet dependency URL is not a valid absolute URL',
          { prepareEvidenceRef: args.prepareEvidenceRef, dependencyUrl: url },
        ),
      };
    }
    if (stylesheetUrls.has(normalized.url)) {
      return {
        ok: false,
        failure: fail(
          'dependency_evidence_mismatch',
          'react bundle runtime manifest contains duplicate stylesheet dependencies',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            dependencyUrl: normalized.url,
          },
        ),
      };
    }
    stylesheetUrls.add(normalized.url);
    manifestDependencies.push({
      key: dependencyKey('stylesheet', normalized.url),
      kind: 'stylesheet',
      url: normalized.url,
    });
  }

  return { ok: true, dependencies: manifestDependencies };
}

function collectPreparedDependencyEvidence(args: {
  evidence: readonly PreparedDependencyEvidence[];
  manifestDependencies: readonly ManifestDependency[];
  prepareEvidenceRef: string;
}):
  | { ok: true; evidenceByKey: Map<string, PreparedDependencyEvidence> }
  | { ok: false; failure: ReactBundleRuntimeManifestAcceptanceResult } {
  const manifestKeys = new Set(
    args.manifestDependencies.map((item) => item.key),
  );
  const evidenceByKey = new Map<string, PreparedDependencyEvidence>();

  for (const evidence of args.evidence) {
    const key = preparedEvidenceKey(evidence);
    if (!key.ok) {
      return {
        ok: false,
        failure: fail(
          'dependency_evidence_mismatch',
          'react bundle dependency evidence URL is not a valid absolute URL',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            dependencyUrl: evidence.url,
          },
        ),
      };
    }
    if (key.key === null || !manifestKeys.has(key.key)) {
      return {
        ok: false,
        failure: fail(
          'dependency_evidence_mismatch',
          'react bundle prepare dependency evidence does not match runtime manifest dependencies',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            dependencyUrl: evidence.url,
          },
        ),
      };
    }
    if (evidenceByKey.has(key.key)) {
      return {
        ok: false,
        failure: fail(
          'dependency_evidence_mismatch',
          'react bundle prepare dependency evidence contains duplicates',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            dependencyUrl: evidence.url,
          },
        ),
      };
    }
    evidenceByKey.set(key.key, evidence);
  }

  if (evidenceByKey.size !== args.manifestDependencies.length) {
    return {
      ok: false,
      failure: fail(
        'dependency_evidence_mismatch',
        'react bundle prepare dependency evidence is missing runtime manifest dependencies',
        { prepareEvidenceRef: args.prepareEvidenceRef },
      ),
    };
  }

  return { ok: true, evidenceByKey };
}

function validateProbeSummary(args: {
  probe: ReactBundleDependencyNetworkProbeSummary;
  manifestDependencies: readonly ManifestDependency[];
  prepareEvidenceRef: string;
}):
  | {
      ok: true;
      evidenceRef: string;
      probesByKey: ValidatedProbeSummary['probesByKey'];
    }
  | { ok: false; failure: ReactBundleRuntimeManifestAcceptanceResult } {
  if (!isOpaqueSandboxOutputEvidenceRef(args.probe.evidenceRef)) {
    return {
      ok: false,
      failure: fail(
        'probe_summary_invalid',
        'react bundle probe evidence ref must be opaque',
        {
          prepareEvidenceRef: args.prepareEvidenceRef,
          probeEvidenceRef: args.probe.evidenceRef,
        },
      ),
    };
  }
  if (
    !args.probe.allRequiredProbesOk ||
    args.probe.failedDependencyCount !== 0 ||
    args.probe.failures.length > 0
  ) {
    return {
      ok: false,
      failure: fail(
        'probe_policy_failed',
        'react bundle metadata probe summary did not pass all required probes',
        {
          prepareEvidenceRef: args.prepareEvidenceRef,
          probeEvidenceRef: args.probe.evidenceRef,
        },
      ),
    };
  }

  const manifestKeys = new Set(
    args.manifestDependencies.map((item) => item.key),
  );
  const probesByKey = new Map<
    string,
    Extract<ReactBundleDependencyNetworkProbeSummaryProbe, { ok: true }>
  >();
  for (const probe of args.probe.dependencyProbes) {
    if (!probe.ok) {
      return {
        ok: false,
        failure: fail(
          'probe_policy_failed',
          'react bundle metadata probe summary contains failed dependency probes',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            probeEvidenceRef: args.probe.evidenceRef,
            dependencyUrl: probe.requestedUrl,
          },
        ),
      };
    }
    const key = probeEvidenceKey(probe);
    if (!key.ok) {
      return {
        ok: false,
        failure: fail(
          'probe_dependency_mismatch',
          'react bundle metadata probe requested URL is not a valid absolute URL',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            probeEvidenceRef: args.probe.evidenceRef,
            dependencyUrl: probe.requestedUrl,
          },
        ),
      };
    }
    if (key.key === null || !manifestKeys.has(key.key)) {
      return {
        ok: false,
        failure: fail(
          'probe_dependency_mismatch',
          'react bundle metadata probe dependency set does not match prepared runtime dependencies',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            probeEvidenceRef: args.probe.evidenceRef,
            dependencyUrl: probe.requestedUrl,
          },
        ),
      };
    }
    if (probesByKey.has(key.key)) {
      return {
        ok: false,
        failure: fail(
          'probe_dependency_mismatch',
          'react bundle metadata probe dependency set contains duplicates',
          {
            prepareEvidenceRef: args.prepareEvidenceRef,
            probeEvidenceRef: args.probe.evidenceRef,
            dependencyUrl: probe.requestedUrl,
          },
        ),
      };
    }
    probesByKey.set(key.key, probe);
  }

  if (probesByKey.size !== args.manifestDependencies.length) {
    return {
      ok: false,
      failure: fail(
        'probe_dependency_mismatch',
        'react bundle metadata probe dependency set is missing prepared runtime dependencies',
        {
          prepareEvidenceRef: args.prepareEvidenceRef,
          probeEvidenceRef: args.probe.evidenceRef,
        },
      ),
    };
  }

  return { ok: true, evidenceRef: args.probe.evidenceRef, probesByKey };
}

function buildSuccess(args: {
  prepare: ReactBundleDependencyPrepareSummary;
  probe?: ReactBundleDependencyNetworkProbeSummary;
  manifestDependencies: readonly ManifestDependency[];
  preparedEvidenceByKey: Map<string, PreparedDependencyEvidence>;
  probesByKey?: ValidatedProbeSummary['probesByKey'];
  dependencyPolicy: ReactBundleRuntimeManifestDependencyPolicy;
  acceptedAt: string;
}): ReactBundleAcceptedRuntimeManifestSummary {
  const hasProbe = args.probe !== undefined;
  return {
    ok: true,
    manifest: args.prepare.manifest,
    acceptance: {
      schemaVersion: 1,
      acceptedAt: args.acceptedAt,
      source: 'explicit_cdn_prepare',
      prepareEvidenceRef: args.prepare.evidenceRef,
      ...(args.probe ? { probeEvidenceRef: args.probe.evidenceRef } : {}),
      entryUrlEvidence: {
        availability: 'not_checked',
        reason: 'runtime_smoke_deferred',
      },
      dependencyPolicy: args.dependencyPolicy,
      dependencyCount: args.manifestDependencies.length,
      probedDependencyCount: hasProbe ? args.manifestDependencies.length : 0,
      unprobedDependencyCount: hasProbe ? 0 : args.manifestDependencies.length,
      networkPolicies: hasProbe
        ? ['none', 'allowlisted_metadata_probe']
        : ['none'],
    },
    dependencyEvidence: args.manifestDependencies.map((dependency) =>
      buildDependencyEvidence({
        dependency,
        prepared: args.preparedEvidenceByKey.get(dependency.key)!,
        ...(args.probesByKey?.get(dependency.key)
          ? { probe: args.probesByKey.get(dependency.key)! }
          : {}),
        ...(args.probe ? { probeEvidenceRef: args.probe.evidenceRef } : {}),
      }),
    ),
  };
}

function buildDependencyEvidence(args: {
  dependency: ManifestDependency;
  prepared: PreparedDependencyEvidence;
  probe?: Extract<ReactBundleDependencyNetworkProbeSummaryProbe, { ok: true }>;
  probeEvidenceRef?: string;
}): ReactBundleAcceptedRuntimeManifestDependencyEvidence {
  return {
    kind: args.dependency.kind,
    ...(args.dependency.specifier
      ? { specifier: args.dependency.specifier }
      : {}),
    ...(args.prepared.packageName
      ? { packageName: args.prepared.packageName }
      : {}),
    ...(args.prepared.version ? { version: args.prepared.version } : {}),
    url: args.dependency.url,
    integrityStatus:
      args.prepared.integrityStatus === 'provided'
        ? 'provided_unverified'
        : 'missing_allowed',
    ...(args.probe && args.probeEvidenceRef
      ? {
          probe: {
            ok: true,
            requestedUrl: args.probe.requestedUrl,
            finalUrl: args.probe.finalUrl,
            method: args.probe.method,
            status: args.probe.status,
            evidenceRef: args.probeEvidenceRef,
          },
        }
      : {}),
  };
}

function preparedEvidenceKey(
  evidence: PreparedDependencyEvidence,
): { ok: true; key: string | null } | { ok: false } {
  const normalized = tryNormalizeUrl(evidence.url);
  if (!normalized.ok) return { ok: false };
  if (evidence.kind === 'esm_import') {
    return {
      ok: true,
      key: evidence.specifier
        ? dependencyKey('esm_import', normalized.url, evidence.specifier)
        : null,
    };
  }
  return { ok: true, key: dependencyKey('stylesheet', normalized.url) };
}

function probeEvidenceKey(
  probe: ReactBundleDependencyNetworkProbeSummaryProbe,
): { ok: true; key: string | null } | { ok: false } {
  const normalized = tryNormalizeUrl(probe.requestedUrl);
  if (!normalized.ok) return { ok: false };
  if (probe.kind === 'esm_import') {
    return {
      ok: true,
      key: probe.specifier
        ? dependencyKey('esm_import', normalized.url, probe.specifier)
        : null,
    };
  }
  return { ok: true, key: dependencyKey('stylesheet', normalized.url) };
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

function tryNormalizeUrl(
  url: string,
): { ok: true; url: string } | { ok: false } {
  try {
    return { ok: true, url: normalizeDependencyUrl(url) };
  } catch {
    return { ok: false };
  }
}

function fail(
  reasonCode: ReactBundleRuntimeManifestAcceptanceFailureReason,
  message: string,
  diagnostics?: FailureDiagnostics,
): Extract<ReactBundleRuntimeManifestAcceptanceResult, { ok: false }> {
  return {
    ok: false,
    reasonCode,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
