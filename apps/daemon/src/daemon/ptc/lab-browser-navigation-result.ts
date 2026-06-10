import { isRecord } from '@geulbat/protocol/runtime-utils';
import { buildPtcLabPublicSessionId } from './lab-session-public-id.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
} from './session-docker-contract.js';
import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_DIGEST,
  type PtcLabBrowserFixedNavigationProbeChecks,
  type PtcLabBrowserFixedNavigationProbeSummary,
  type PtcLabBrowserNavigationFailureReason,
  type PtcLabBrowserNavigationResult,
  type RunPtcLabBrowserFixedNavigationProbeArgs,
  browserNavigationFailure,
} from './lab-browser-navigation-contract.js';
import type {
  PtcLabBrowserNavigationPolicy,
  PtcLabBrowserValidatedNavigationRequest,
} from './lab-browser-navigation-policy.js';
import {
  formatPtcLabBrowserAdapterStdoutParseFailure,
  parsePtcLabBrowserAdapterStdout,
} from './lab-browser-json-line-output.js';
import { PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS } from './lab-browser-output-guard.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from './session-taint-close.js';

const PTC_LAB_BROWSER_NAVIGATION_MAX_STDOUT_BYTES = 4 * 1024;

type ParsedNavigationStdout =
  | { ok: true; checks: PtcLabBrowserFixedNavigationProbeChecks }
  | {
      ok: false;
      checks: PtcLabBrowserFixedNavigationProbeChecks;
      errorCode: NavigationStdoutErrorCode;
    };

type NavigationStdoutErrorCode =
  | 'browser_runtime_unavailable'
  | 'target_unavailable'
  | 'navigation_failed'
  | 'cleanup_failed'
  | 'cleanup_uncertain';

const NAVIGATION_STDOUT_ERROR_CODES = [
  'browser_runtime_unavailable',
  'target_unavailable',
  'navigation_failed',
  'cleanup_failed',
  'cleanup_uncertain',
] as const satisfies readonly NavigationStdoutErrorCode[];

export async function mapBrowserNavigationExecution(args: {
  runArgs: RunPtcLabBrowserFixedNavigationProbeArgs;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  handle: PtcSessionDockerHandle;
  policy: PtcLabBrowserNavigationPolicy;
  request: PtcLabBrowserValidatedNavigationRequest;
}): Promise<
  PtcLabBrowserNavigationResult<PtcLabBrowserFixedNavigationProbeSummary>
> {
  if (args.execution.kind === 'timeout') {
    const diagnostics = toBrowserNavigationTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserNavigationFailure(
      'ptc_lab_browser_timeout',
      'PTC lab browser navigation probe timed out',
      diagnostics,
    );
  }
  if (args.execution.kind === 'cancelled') {
    const diagnostics = toBrowserNavigationTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserNavigationFailure(
      'ptc_lab_browser_cancelled',
      'PTC lab browser navigation probe was cancelled',
      diagnostics,
    );
  }
  if (args.execution.kind === 'crash') {
    const diagnostics = toBrowserNavigationTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserNavigationFailure(
      'ptc_lab_browser_navigation_failed',
      'PTC lab browser navigation probe failed to execute',
      { commandResultKind: 'crash', ...(diagnostics ?? {}) },
    );
  }

  const parsed = parseNavigationStdout(args.execution.stdout);
  if (!parsed.ok) {
    return parsed;
  }
  if (!parsed.value.ok) {
    if (
      parsed.value.errorCode === 'cleanup_failed' ||
      parsed.value.errorCode === 'cleanup_uncertain'
    ) {
      const diagnostics = toBrowserNavigationTaintDiagnostics(
        await closeTaintedPtcDockerSession(args.runArgs),
      );
      return browserNavigationFailure(
        parsed.value.errorCode === 'cleanup_failed'
          ? 'ptc_lab_browser_cleanup_failed'
          : 'ptc_lab_browser_cleanup_uncertain',
        'PTC lab browser navigation probe cleanup was not proven',
        diagnostics,
      );
    }
    return browserNavigationFailure(
      mapNavigationErrorCode(parsed.value.errorCode),
      parsed.value.errorCode === 'browser_runtime_unavailable'
        ? 'PTC lab browser runtime is unavailable'
        : parsed.value.errorCode === 'target_unavailable'
          ? 'PTC lab browser fixed navigation target is unavailable'
          : 'PTC lab browser fixed navigation probe failed',
    );
  }
  if (args.execution.exitCode !== 0 || !allChecksPassed(parsed.value.checks)) {
    return browserNavigationFailure(
      'ptc_lab_browser_output_invalid',
      'PTC lab browser navigation probe stdout has inconsistent success shape',
    );
  }

  return {
    ok: true,
    value: {
      ok: true,
      profile: 'lab',
      capability: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
      policyId: args.policy.policyId,
      labSessionId: buildPtcLabPublicSessionId(args.handle),
      probeId: args.request.probeId,
      targetRef: args.request.targetRef,
      targetDigest: PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_DIGEST,
      browserPolicyId: args.policy.browser.browserPolicyId,
      browserMode: args.policy.browser.mode,
      browserRuntimeEnginePolicyId: args.policy.browser.runtimeEnginePolicyId,
      browserNetworkPolicyId: args.policy.browser.networkPolicyId,
      browserNavigationTargetPolicyId:
        args.policy.browser.navigationTargetPolicyId,
      browserUrlGrammarPolicyId: args.policy.browser.urlGrammarPolicyId,
      browserRedirectPolicyId: args.policy.browser.redirectPolicyId,
      browserTelemetryPolicyId: args.policy.browser.telemetryPolicyId,
      browserOutputPolicy: args.policy.browser.outputPolicy,
      browserEvidencePolicyId: args.policy.browser.evidencePolicyId,
      browserProfilePolicyId: args.policy.browser.profilePolicyId,
      browserCookieStorePolicyId: args.policy.browser.cookieStorePolicyId,
      browserArtifactExportPolicyId: args.policy.browser.artifactExportPolicyId,
      browserProfile: 'none',
      browserCookies: 'none',
      artifactExported: false,
      navigationOutcome: 'loaded',
      checks: parsed.value.checks,
      durationMs: args.durationMs,
    },
  };
}

export function browserNavigationSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserNavigationResult<never> {
  return browserNavigationFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser navigation session is unavailable',
    { sessionReasonCode: reasonCode },
  );
}

function toBrowserNavigationTaintDiagnostics(
  outcome: PtcSessionTaintCloseOutcome,
): Record<string, string | number | boolean> | undefined {
  if (outcome.closeProven) {
    return undefined;
  }
  return {
    sessionTainted: true,
    sessionCloseFailed: true,
    ...(outcome.closeStatus === 'failed_result'
      ? { sessionReasonCode: outcome.sessionReasonCode }
      : {}),
  };
}

function parseNavigationStdout(
  stdout: string,
): PtcLabBrowserNavigationResult<ParsedNavigationStdout> {
  const parsed = parsePtcLabBrowserAdapterStdout({
    capability: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
    errorCodes: NAVIGATION_STDOUT_ERROR_CODES,
    extraForbiddenKeys:
      PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS,
    forbidTargetHostname: true,
    isChecks,
    maxStdoutBytes: PTC_LAB_BROWSER_NAVIGATION_MAX_STDOUT_BYTES,
    stdout,
    targetUrl: PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url,
  });
  if (!parsed.ok) {
    return outputInvalid(
      formatPtcLabBrowserAdapterStdoutParseFailure({
        reason: parsed.reason,
        subject: 'navigation probe',
      }),
    );
  }
  return { ok: true, value: parsed.value };
}

function outputInvalid(message: string): PtcLabBrowserNavigationResult<never> {
  return browserNavigationFailure('ptc_lab_browser_output_invalid', message);
}

function mapNavigationErrorCode(
  errorCode: Extract<ParsedNavigationStdout, { ok: false }>['errorCode'],
): PtcLabBrowserNavigationFailureReason {
  if (errorCode === 'browser_runtime_unavailable') {
    return 'ptc_lab_browser_runtime_unavailable';
  }
  if (errorCode === 'target_unavailable') {
    return 'ptc_lab_browser_target_unavailable';
  }
  return 'ptc_lab_browser_navigation_failed';
}

function allChecksPassed(
  checks: PtcLabBrowserFixedNavigationProbeChecks,
): boolean {
  return (
    checks.engineAvailable &&
    checks.contextCreated &&
    checks.navigationCommitted &&
    checks.loadStateReached &&
    checks.cleanupCompleted
  );
}

function isChecks(
  value: unknown,
): value is PtcLabBrowserFixedNavigationProbeChecks {
  return (
    isRecord(value) &&
    typeof value.engineAvailable === 'boolean' &&
    typeof value.contextCreated === 'boolean' &&
    typeof value.navigationCommitted === 'boolean' &&
    typeof value.loadStateReached === 'boolean' &&
    typeof value.cleanupCompleted === 'boolean'
  );
}
