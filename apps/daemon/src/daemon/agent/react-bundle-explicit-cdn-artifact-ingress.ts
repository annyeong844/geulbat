import type { SandboxAttemptStore } from '../sandbox/attempt-store.js';
import {
  buildReactBundleAcceptedManifestArtifactCandidate,
  type ReactBundleAcceptedManifestArtifactCandidateResult,
  type ReactBundleAcceptedRuntimeManifestSuccess,
} from '../react-bundle-dependency-admission/react-bundle-accepted-manifest-artifact-candidate.js';
import { acceptReactBundleRuntimeManifest } from '../react-bundle-dependency-admission/react-bundle-accepted-runtime-manifest.js';
import { probeReactBundleExplicitCdnDependencies } from '../react-bundle-dependency-admission/react-bundle-dependency-network-probe.js';
import {
  prepareReactBundleExplicitCdnDependencies,
  type ReactBundleDependencyPrepareRequest,
} from '../react-bundle-dependency-admission/react-bundle-dependency-prepare.js';
import { composeAgentResult, type AgentResult } from './agent-result.js';

type ReactBundleDependencyProbeArgs = Parameters<
  typeof probeReactBundleExplicitCdnDependencies
>[0];

export type ReactBundleExplicitCdnArtifactIngressRequest =
  ReactBundleDependencyPrepareRequest;

export type ReactBundleExplicitCdnArtifactIngressFailureReason =
  | 'prepare_failed'
  | 'probe_failed'
  | 'probe_timeout_policy_missing'
  | 'acceptance_failed'
  | 'artifact_candidate_failed';

export type ReactBundleExplicitCdnArtifactIngressResult =
  | {
      ok: true;
      result: AgentResult;
      accepted: ReactBundleAcceptedRuntimeManifestSuccess;
      handoff: Extract<
        ReactBundleAcceptedManifestArtifactCandidateResult,
        { ok: true }
      >['handoff'];
    }
  | {
      ok: false;
      reasonCode: ReactBundleExplicitCdnArtifactIngressFailureReason;
      message: string;
      diagnostics?: {
        prepareEvidenceRef?: string;
        probeEvidenceRef?: string;
        underlyingReasonCode?: string;
      };
    };

type FailureDiagnostics = Extract<
  ReactBundleExplicitCdnArtifactIngressResult,
  { ok: false }
>['diagnostics'];

export async function runReactBundleExplicitCdnArtifactIngress(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  request: ReactBundleExplicitCdnArtifactIngressRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => string;
  probeTransport?: ReactBundleDependencyProbeArgs['probeTransport'];
  acceptRuntimeManifest?: typeof acceptReactBundleRuntimeManifest;
  buildArtifactCandidate?: typeof buildReactBundleAcceptedManifestArtifactCandidate;
}): Promise<ReactBundleExplicitCdnArtifactIngressResult> {
  let prepare: Awaited<
    ReturnType<typeof prepareReactBundleExplicitCdnDependencies>
  >;
  try {
    prepare = await prepareReactBundleExplicitCdnDependencies({
      workspaceRoot: args.workspaceRoot,
      store: args.store,
      request: args.request,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
  } catch (error: unknown) {
    return fail('prepare_failed', readErrorMessage(error));
  }

  const dependencyCount = prepare.provenanceSummary.dependencyCount;
  let probe:
    | Awaited<ReturnType<typeof probeReactBundleExplicitCdnDependencies>>
    | undefined;

  if (dependencyCount > 0) {
    if (args.timeoutMs === undefined) {
      return fail(
        'probe_timeout_policy_missing',
        'react bundle dependency metadata probe requires explicit timeoutMs',
        mergeFailureDiagnostics({
          prepareEvidenceRef: prepare.evidenceRef,
        }),
      );
    }
    try {
      probe = await probeReactBundleExplicitCdnDependencies({
        workspaceRoot: args.workspaceRoot,
        store: args.store,
        request: args.request,
        ...(args.now ? { now: args.now } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.probeTransport ? { probeTransport: args.probeTransport } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      });
    } catch (error: unknown) {
      return fail(
        'probe_failed',
        readErrorMessage(error),
        mergeFailureDiagnostics({
          prepareEvidenceRef: prepare.evidenceRef,
        }),
      );
    }
  }

  const accept = args.acceptRuntimeManifest ?? acceptReactBundleRuntimeManifest;
  const accepted = accept({
    prepare,
    ...(probe ? { probe } : {}),
    ...(args.now ? { now: args.now } : {}),
  });
  if (!accepted.ok) {
    return fail(
      'acceptance_failed',
      accepted.message,
      mergeFailureDiagnostics(accepted.diagnostics, accepted.reasonCode),
    );
  }

  const buildArtifactCandidate =
    args.buildArtifactCandidate ??
    buildReactBundleAcceptedManifestArtifactCandidate;
  const handoff = buildArtifactCandidate({ accepted });
  if (!handoff.ok) {
    return fail(
      'artifact_candidate_failed',
      handoff.message,
      mergeFailureDiagnostics(handoff.diagnostics, handoff.reasonCode),
    );
  }

  return {
    ok: true,
    result: composeAgentResult({
      ok: true,
      artifactCandidate: handoff.artifactCandidate,
    }),
    accepted,
    handoff: handoff.handoff,
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeFailureDiagnostics(
  diagnostics:
    | {
        prepareEvidenceRef?: string;
        probeEvidenceRef?: string;
      }
    | undefined,
  underlyingReasonCode?: string,
): FailureDiagnostics {
  const safe: NonNullable<FailureDiagnostics> = {};
  if (underlyingReasonCode !== undefined) {
    safe.underlyingReasonCode = underlyingReasonCode;
  }
  if (!diagnostics) {
    return Object.keys(safe).length > 0 ? safe : undefined;
  }
  if (
    diagnostics.prepareEvidenceRef !== undefined &&
    isOpaqueEvidenceRef(diagnostics.prepareEvidenceRef)
  ) {
    safe.prepareEvidenceRef = diagnostics.prepareEvidenceRef;
  }
  if (
    diagnostics.probeEvidenceRef !== undefined &&
    isOpaqueEvidenceRef(diagnostics.probeEvidenceRef)
  ) {
    safe.probeEvidenceRef = diagnostics.probeEvidenceRef;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
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

function fail(
  reasonCode: ReactBundleExplicitCdnArtifactIngressFailureReason,
  message: string,
  diagnostics?: FailureDiagnostics,
): Extract<ReactBundleExplicitCdnArtifactIngressResult, { ok: false }> {
  return {
    ok: false,
    reasonCode,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
