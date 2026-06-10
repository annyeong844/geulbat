import { isRecord } from '@geulbat/protocol/runtime-utils';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
} from './session-docker-contract.js';
import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_RESULT_KIND,
  type PtcLabBrowserUserUrlNavigationChecks,
  type PtcLabBrowserUserUrlNavigationFailureReason,
  type PtcLabBrowserUserUrlNavigationPhase,
  type PtcLabBrowserUserUrlNavigationResult,
  type PtcLabBrowserUserUrlNavigationSummary,
  type RunPtcLabBrowserUserUrlNavigationRuntimeArgs,
  browserUserUrlNavigationFailure,
  type PtcLabBrowserUserUrlNavigationExecutionIdentity,
} from './lab-browser-user-url-navigation-contract.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY } from './lab-browser-url-navigation.js';
import type {
  PtcLabBrowserUserUrlNavigationPolicy,
  PtcLabBrowserValidatedUserUrlNavigationRequest,
} from './lab-browser-user-url-navigation-policy.js';
import { PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS } from './lab-browser-output-guard.js';
import {
  formatPtcLabBrowserAdapterStdoutParseFailure,
  parsePtcLabBrowserAdapterStdout,
} from './lab-browser-json-line-output.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from './session-taint-close.js';

const PTC_LAB_BROWSER_USER_URL_NAVIGATION_MAX_STDOUT_BYTES = 4 * 1024;

type ParsedUserUrlNavigationStdout =
  | {
      ok: true;
      checks: Omit<PtcLabBrowserUserUrlNavigationChecks, 'targetVerified'>;
    }
  | {
      ok: false;
      checks: Omit<PtcLabBrowserUserUrlNavigationChecks, 'targetVerified'>;
      errorCode: UserUrlNavigationStdoutErrorCode;
    };

type UserUrlNavigationStdoutErrorCode =
  | 'browser_runtime_unavailable'
  | 'navigation_failed'
  | 'redirect_disallowed'
  | 'download_disallowed'
  | 'popup_disallowed'
  | 'cleanup_failed'
  | 'cleanup_uncertain';

const USER_URL_NAVIGATION_STDOUT_ERROR_CODES = [
  'browser_runtime_unavailable',
  'navigation_failed',
  'redirect_disallowed',
  'download_disallowed',
  'popup_disallowed',
  'cleanup_failed',
  'cleanup_uncertain',
] as const satisfies readonly UserUrlNavigationStdoutErrorCode[];

export async function mapBrowserUserUrlNavigationExecution(args: {
  runArgs: RunPtcLabBrowserUserUrlNavigationRuntimeArgs;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  handle: PtcSessionDockerHandle;
  policy: PtcLabBrowserUserUrlNavigationPolicy;
  request: PtcLabBrowserValidatedUserUrlNavigationRequest;
  executionIdentity: PtcLabBrowserUserUrlNavigationExecutionIdentity;
}): Promise<
  PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationSummary>
> {
  if (args.execution.kind === 'timeout') {
    const taint = toUserUrlNavigationTaintEnvelope(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_timeout',
      'PTC lab browser user URL navigation timed out',
      'navigation',
      {
        targetDigest: args.executionIdentity.targetDigest,
        navigationAttemptDigest: args.executionIdentity.navigationAttemptDigest,
        ...taint,
      },
    );
  }
  if (args.execution.kind === 'cancelled') {
    const taint = toUserUrlNavigationTaintEnvelope(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_cancelled',
      'PTC lab browser user URL navigation was cancelled',
      'navigation',
      {
        targetDigest: args.executionIdentity.targetDigest,
        navigationAttemptDigest: args.executionIdentity.navigationAttemptDigest,
        ...taint,
      },
    );
  }
  if (args.execution.kind === 'crash') {
    const taint = toUserUrlNavigationTaintEnvelope(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_navigation_failed',
      'PTC lab browser user URL navigation failed to execute',
      'navigation',
      {
        targetDigest: args.executionIdentity.targetDigest,
        navigationAttemptDigest: args.executionIdentity.navigationAttemptDigest,
        diagnostics: { commandResultKind: 'crash' },
        ...taint,
      },
    );
  }

  const parsed = parseUserUrlNavigationStdout({
    stdout: args.execution.stdout,
    targetUrl: args.request.target.url,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (!parsed.value.ok) {
    if (
      parsed.value.errorCode === 'cleanup_failed' ||
      parsed.value.errorCode === 'cleanup_uncertain'
    ) {
      const taint = toUserUrlNavigationTaintEnvelope(
        await closeTaintedPtcDockerSession(args.runArgs),
      );
      return browserUserUrlNavigationFailure(
        parsed.value.errorCode === 'cleanup_failed'
          ? 'ptc_lab_browser_cleanup_failed'
          : 'ptc_lab_browser_cleanup_uncertain',
        'PTC lab browser user URL navigation cleanup was not proven',
        'cleanup',
        {
          targetDigest: args.executionIdentity.targetDigest,
          navigationAttemptDigest:
            args.executionIdentity.navigationAttemptDigest,
          ...taint,
        },
      );
    }

    return browserUserUrlNavigationFailure(
      mapUserUrlNavigationErrorCode(parsed.value.errorCode),
      parsed.value.errorCode === 'browser_runtime_unavailable'
        ? 'PTC lab browser runtime is unavailable'
        : 'PTC lab browser user URL navigation failed',
      mapUserUrlNavigationErrorPhase(parsed.value.errorCode),
      {
        targetDigest: args.executionIdentity.targetDigest,
        navigationAttemptDigest: args.executionIdentity.navigationAttemptDigest,
        sessionLifecycle: {
          mode: 'runtime_owned',
          retainedAfterExecution: true,
          taintedAfterExecution: false,
        },
      },
    );
  }
  if (args.execution.exitCode !== 0 || !allChecksPassed(parsed.value.checks)) {
    return outputInvalid(
      'PTC lab browser user URL navigation stdout has inconsistent success shape',
      args.executionIdentity,
    );
  }

  return {
    ok: true,
    value: {
      kind: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RESULT_KIND,
      ok: true,
      profile: 'lab',
      capability: PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
      targetDigest: args.executionIdentity.targetDigest,
      navigationAttemptDigest: args.executionIdentity.navigationAttemptDigest,
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: true,
        taintedAfterExecution: false,
      },
      browserPolicyId: args.policy.browser.browserPolicyId,
      browserMode: args.policy.browser.mode,
      browserEnginePolicyId: args.policy.browser.browserEnginePolicyId,
      browserNetworkPolicyId: args.policy.browser.networkPolicyId,
      browserUrlGrammarPolicyId: args.policy.browser.urlGrammarPolicyId,
      browserRedirectPolicyId: args.policy.browser.redirectPolicyId,
      browserEvidencePolicyId: args.policy.browser.evidencePolicyId,
      browserUrlEchoPolicyId: args.policy.browser.urlEchoPolicyId,
      browserPopupPolicyId: args.policy.browser.popupPolicyId,
      browserPermissionPolicyId: args.policy.browser.permissionPolicyId,
      browserProfilePolicyId: args.policy.browser.profilePolicyId,
      browserCookieStorePolicyId: args.policy.browser.cookieStorePolicyId,
      browserDownloadPolicyId: args.policy.browser.downloadPolicyId,
      browserArtifactExportPolicyId: args.policy.browser.artifactExportPolicyId,
      artifactExported: false,
      requestedUrlRedacted: true,
      finalUrlRedacted: true,
      navigationOutcome: 'loaded',
      loadState: 'domcontentloaded',
      checks: { targetVerified: true, ...parsed.value.checks },
      durationMs: args.durationMs,
    },
  };
}

export function browserUserUrlNavigationSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserUserUrlNavigationResult<never> {
  return browserUserUrlNavigationFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser user URL navigation session is unavailable',
    'session_acquisition',
    { diagnostics: { sessionReasonCode: reasonCode } },
  );
}

function toUserUrlNavigationTaintEnvelope(
  outcome: PtcSessionTaintCloseOutcome,
): Pick<
  Extract<PtcLabBrowserUserUrlNavigationResult<never>, { ok: false }>,
  'diagnostics' | 'sessionLifecycle'
> {
  const sessionLifecycle = {
    mode: 'runtime_owned' as const,
    retainedAfterExecution: false,
    taintedAfterExecution: true,
  };
  if (outcome.closeProven) {
    return { sessionLifecycle };
  }
  return {
    sessionLifecycle,
    diagnostics: {
      sessionTainted: true,
      sessionCloseFailed: true,
      ...(outcome.closeStatus === 'failed_result'
        ? { sessionReasonCode: outcome.sessionReasonCode }
        : {}),
    },
  };
}

function parseUserUrlNavigationStdout(args: {
  stdout: string;
  targetUrl: string;
}): PtcLabBrowserUserUrlNavigationResult<ParsedUserUrlNavigationStdout> {
  const parsed = parsePtcLabBrowserAdapterStdout({
    capability: PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
    errorCodes: USER_URL_NAVIGATION_STDOUT_ERROR_CODES,
    extraForbiddenKeys:
      PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS,
    forbidTargetHostname: true,
    forbidTargetSearchAndHash: true,
    isChecks,
    maxStdoutBytes: PTC_LAB_BROWSER_USER_URL_NAVIGATION_MAX_STDOUT_BYTES,
    stdout: args.stdout,
    targetUrl: args.targetUrl,
  });
  if (!parsed.ok) {
    return outputInvalid(
      formatPtcLabBrowserAdapterStdoutParseFailure({
        reason: parsed.reason,
        subject: 'user URL navigation',
      }),
    );
  }
  return { ok: true, value: parsed.value };
}

function outputInvalid(
  message: string,
  executionIdentity?: PtcLabBrowserUserUrlNavigationExecutionIdentity,
): PtcLabBrowserUserUrlNavigationResult<never> {
  return browserUserUrlNavigationFailure(
    'ptc_lab_browser_output_invalid',
    message,
    'output_serialization',
    executionIdentity === undefined
      ? {}
      : {
          targetDigest: executionIdentity.targetDigest,
          navigationAttemptDigest: executionIdentity.navigationAttemptDigest,
        },
  );
}

function mapUserUrlNavigationErrorCode(
  errorCode: Extract<ParsedUserUrlNavigationStdout, { ok: false }>['errorCode'],
): PtcLabBrowserUserUrlNavigationFailureReason {
  if (errorCode === 'browser_runtime_unavailable') {
    return 'ptc_lab_browser_runtime_unavailable';
  }
  if (errorCode === 'redirect_disallowed') {
    return 'ptc_lab_browser_redirect_disallowed';
  }
  if (errorCode === 'download_disallowed') {
    return 'ptc_lab_browser_download_disallowed';
  }
  if (errorCode === 'popup_disallowed') {
    return 'ptc_lab_browser_popup_disallowed';
  }
  return 'ptc_lab_browser_navigation_failed';
}

function mapUserUrlNavigationErrorPhase(
  errorCode: Extract<ParsedUserUrlNavigationStdout, { ok: false }>['errorCode'],
): PtcLabBrowserUserUrlNavigationPhase {
  if (errorCode === 'browser_runtime_unavailable') {
    return 'runtime_start';
  }
  if (errorCode === 'redirect_disallowed') {
    return 'redirect_revalidation';
  }
  if (errorCode === 'download_disallowed') {
    return 'download_policy';
  }
  if (errorCode === 'popup_disallowed') {
    return 'popup_policy';
  }
  return 'navigation';
}

function allChecksPassed(
  checks: Omit<PtcLabBrowserUserUrlNavigationChecks, 'targetVerified'>,
): boolean {
  return (
    checks.engineAvailable &&
    checks.contextCreated &&
    checks.navigationStarted &&
    checks.navigationSettled &&
    checks.redirectPolicyEnforced &&
    checks.downloadPolicyEnforced &&
    checks.cleanupCompleted
  );
}

function isChecks(
  value: unknown,
): value is Omit<PtcLabBrowserUserUrlNavigationChecks, 'targetVerified'> {
  return (
    isRecord(value) &&
    typeof value.engineAvailable === 'boolean' &&
    typeof value.contextCreated === 'boolean' &&
    typeof value.navigationStarted === 'boolean' &&
    typeof value.navigationSettled === 'boolean' &&
    typeof value.redirectPolicyEnforced === 'boolean' &&
    typeof value.downloadPolicyEnforced === 'boolean' &&
    typeof value.cleanupCompleted === 'boolean'
  );
}
