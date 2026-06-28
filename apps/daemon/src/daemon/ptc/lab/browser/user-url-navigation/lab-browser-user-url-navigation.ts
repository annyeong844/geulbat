import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_RESULT_KIND,
  buildPtcLabBrowserUserUrlNavigationExecutionIdentity,
  type PtcLabBrowserUserUrlNavigationChecks,
  type PtcLabBrowserUserUrlNavigationExecutionIdentity,
  type PtcLabBrowserUserUrlNavigationFailureReason,
  type PtcLabBrowserUserUrlNavigationPhase,
  type PtcLabBrowserUserUrlNavigationResult,
  type PtcLabBrowserUserUrlNavigationSummary,
  type RunPtcLabBrowserUserUrlNavigationArgs,
  browserUserUrlNavigationFailure,
} from './lab-browser-user-url-navigation-contract.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT } from '../core/lab-browser-runtime-script.js';
import {
  PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE,
  mapPtcLabBrowserAdapterFailureToResult,
  mapPtcLabBrowserCommandFailureToResult,
  type PtcLabBrowserCommandExecutionKind,
} from '../core/lab-browser-result-contract.js';
import { buildPtcLabBrowserUserUrlNavigationSummaryPolicyFields } from '../core/lab-browser-policy-fields.js';
import {
  readBrowserUserUrlNavigationPolicy,
  validateBrowserUserUrlNavigationRequest,
  validateBrowserUserUrlNavigationSession,
  type PtcLabBrowserUserUrlNavigationPolicy,
  type PtcLabBrowserValidatedUserUrlNavigationRequest,
} from './lab-browser-user-url-navigation-policy.js';
import { PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS } from '../core/lab-browser-output-guard.js';
import {
  formatPtcLabBrowserAdapterStdoutParseFailure,
  parsePtcLabBrowserAdapterStdout,
} from '../core/lab-browser-json-line-output.js';
import { toPtcLabBrowserTaintedSessionEnvelope } from '../core/lab-browser-runtime-cleanup.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY } from '../core/lab-browser-url-navigation.js';
import {
  runPtcLabBrowserRuntimeExecution,
  type PtcLabBrowserRuntimeExecutionOwnerArgs,
} from '../core/lab-browser-runtime-execution.js';
import { definedPtcProps, isPtcRecord } from '../../../shared/record-shape.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
} from '../../session/session-docker-contract.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseInput,
} from '../../session/session-taint-close.js';

const PTC_LAB_BROWSER_USER_URL_NAVIGATION_SUBJECT = 'user URL navigation';

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

type UserUrlNavigationCommandFailureMapping = {
  reasonCode: PtcLabBrowserUserUrlNavigationFailureReason;
  message: string;
  phase: PtcLabBrowserUserUrlNavigationPhase;
  extras:
    | Record<never, never>
    | { diagnostics: { commandResultKind: 'crash' } };
};

type UserUrlNavigationAdapterFailureMapping =
  | {
      taintsSession: true;
      reasonCode: PtcLabBrowserUserUrlNavigationFailureReason;
      message: string;
      phase: PtcLabBrowserUserUrlNavigationPhase;
    }
  | {
      taintsSession: false;
      reasonCode: PtcLabBrowserUserUrlNavigationFailureReason;
      message: string;
      phase: PtcLabBrowserUserUrlNavigationPhase;
    };

const USER_URL_NAVIGATION_STDOUT_ERROR_CODES = [
  'browser_runtime_unavailable',
  'navigation_failed',
  'redirect_disallowed',
  'download_disallowed',
  'popup_disallowed',
  'cleanup_failed',
  'cleanup_uncertain',
] as const satisfies readonly UserUrlNavigationStdoutErrorCode[];

type RunPtcLabBrowserUserUrlNavigationRuntimeArgs =
  PtcLabBrowserRuntimeExecutionOwnerArgs<
    PtcLabBrowserUserUrlNavigationPolicy,
    PtcLabBrowserValidatedUserUrlNavigationRequest
  >;

export async function runPtcLabBrowserUserUrlNavigation(
  args: RunPtcLabBrowserUserUrlNavigationArgs,
): Promise<
  PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationSummary>
> {
  const ownerStartMs = (args.now ?? Date.now)();
  const policy = readBrowserUserUrlNavigationPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserUserUrlNavigationRequest({
    request: args.request,
    maxTimeoutMs: policy.value.browser.maxActionMs,
  });
  if (!request.ok) {
    return request;
  }

  return await runPtcLabBrowserUserUrlNavigationRuntime({
    policy: policy.value,
    request: request.value,
    identity: args.identity,
    sessionManager: args.sessionManager,
    ownerStartMs,
    ...definedPtcProps({
      commandRunner: args.commandRunner,
      dockerPath: args.dockerPath,
      now: args.now,
      signal: args.signal,
    }),
  });
}

async function runPtcLabBrowserUserUrlNavigationRuntime(
  args: RunPtcLabBrowserUserUrlNavigationRuntimeArgs,
): Promise<
  PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationSummary>
> {
  const now = args.now ?? Date.now;
  const start = args.ownerStartMs ?? now();

  const executionIdentity =
    buildPtcLabBrowserUserUrlNavigationExecutionIdentity({
      browser: args.policy.browser,
      effectiveTimeoutMs: args.request.timeoutMs,
      targetDigest: args.request.target.targetDigest,
    });
  const runtimeExecution = await runPtcLabBrowserRuntimeExecution({
    command: {
      attemptDigest: executionIdentity.navigationAttemptDigest,
      ...definedPtcProps({
        commandRunner: args.commandRunner,
        dockerPath: args.dockerPath,
      }),
      identity: args.identity,
      inputEnvelope: {
        targetUrl: args.request.target.url,
        timeoutMs: args.request.timeoutMs,
        loadWaitState: 'domcontentloaded',
      },
      ownerKind: 'user_url_navigation',
      outputBufferPolicy: {
        maxBufferedBytesPerStream: args.policy.shell.maxBufferedBytesPerStream,
      },
      runtimeScript: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
      sessionManager: args.sessionManager,
      sessionUnavailable: browserUserUrlNavigationSessionUnavailable,
      ...definedPtcProps({ signal: args.signal }),
      timeoutMs: args.request.timeoutMs,
      validateSession: (handle) => {
        const sessionValidation = validateBrowserUserUrlNavigationSession({
          handle,
          policyId: args.policy.policyId,
          browser: args.policy.browser,
          network: args.policy.network,
        });
        return sessionValidation.ok
          ? { ok: true }
          : { ok: false, failure: sessionValidation };
      },
    },
    messages: {
      cancelled: 'PTC lab browser user URL navigation was cancelled',
      cleanupUncertain:
        'PTC lab browser user URL navigation input cleanup was not proven',
      executionFailed: 'PTC lab browser user URL navigation failed to execute',
      inputPrepareFailed:
        'PTC lab browser user URL navigation input envelope could not be prepared',
      runnerThrew: 'PTC lab browser user URL navigation runner failed',
      timedOut: 'PTC lab browser user URL navigation timed out',
    },
    mapFailure: (failure) =>
      browserUserUrlNavigationFailure(
        failure.reasonCode,
        failure.message,
        failure.phase,
        {
          targetDigest: executionIdentity.targetDigest,
          navigationAttemptDigest: executionIdentity.navigationAttemptDigest,
          ...failure.details,
        },
      ),
  });
  if (!runtimeExecution.ok) {
    return runtimeExecution.failure;
  }

  return await mapBrowserUserUrlNavigationExecution({
    sessionTaintClose: {
      identity: args.identity,
      sessionManager: args.sessionManager,
    },
    execution: runtimeExecution.execution,
    durationMs: Math.max(0, now() - start),
    policy: args.policy,
    request: args.request,
    executionIdentity,
  });
}

async function mapBrowserUserUrlNavigationExecution(args: {
  sessionTaintClose: PtcSessionTaintCloseInput;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  policy: PtcLabBrowserUserUrlNavigationPolicy;
  request: PtcLabBrowserValidatedUserUrlNavigationRequest;
  executionIdentity: PtcLabBrowserUserUrlNavigationExecutionIdentity;
}): Promise<
  PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationSummary>
> {
  const attemptDetails = {
    targetDigest: args.executionIdentity.targetDigest,
    navigationAttemptDigest: args.executionIdentity.navigationAttemptDigest,
  };
  const closeTaintedSession = async () =>
    toPtcLabBrowserTaintedSessionEnvelope(
      await closeTaintedPtcDockerSession(args.sessionTaintClose),
    );

  if (args.execution.kind !== 'exit') {
    return await mapPtcLabBrowserCommandFailureToResult({
      attemptDetails,
      closeTaintedSession,
      executionKind: args.execution.kind,
      mapFailure: mapUserUrlNavigationCommandFailure,
      toFailure: (failure) =>
        browserUserUrlNavigationFailure(
          failure.reasonCode,
          failure.message,
          failure.phase,
          failure.details,
        ),
    });
  }

  const parsed = parseUserUrlNavigationStdout({
    stdout: args.execution.stdout,
    targetUrl: args.request.target.url,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (!parsed.value.ok) {
    return await mapPtcLabBrowserAdapterFailureToResult({
      attemptDetails,
      closeTaintedSession,
      errorCode: parsed.value.errorCode,
      mapFailure: mapUserUrlNavigationAdapterFailure,
      toFailure: (failure) =>
        browserUserUrlNavigationFailure(
          failure.reasonCode,
          failure.message,
          failure.phase,
          failure.details,
        ),
    });
  }
  if (args.execution.exitCode !== 0 || !allChecksPassed(parsed.value.checks)) {
    return userUrlNavigationOutputInvalid(
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
      sessionLifecycle:
        PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE,
      ...buildPtcLabBrowserUserUrlNavigationSummaryPolicyFields(
        args.policy.browser,
      ),
      requestedUrlRedacted: true,
      finalUrlRedacted: true,
      navigationOutcome: 'loaded',
      loadState: 'domcontentloaded',
      checks: { targetVerified: true, ...parsed.value.checks },
      durationMs: args.durationMs,
    },
  };
}

function browserUserUrlNavigationSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserUserUrlNavigationResult<never> {
  return browserUserUrlNavigationFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser user URL navigation session is unavailable',
    'session_acquisition',
    { diagnostics: { sessionReasonCode: reasonCode } },
  );
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
    stdout: args.stdout,
    targetUrl: args.targetUrl,
  });
  if (!parsed.ok) {
    return userUrlNavigationOutputInvalid(
      formatPtcLabBrowserAdapterStdoutParseFailure({
        reason: parsed.reason,
        subject: 'user URL navigation',
      }),
    );
  }
  return { ok: true, value: parsed.value };
}

function userUrlNavigationOutputInvalid(
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

function mapUserUrlNavigationCommandFailure(
  executionKind: PtcLabBrowserCommandExecutionKind,
): UserUrlNavigationCommandFailureMapping {
  if (executionKind === 'timeout') {
    return {
      reasonCode: 'ptc_lab_browser_timeout',
      message: `PTC lab browser ${PTC_LAB_BROWSER_USER_URL_NAVIGATION_SUBJECT} timed out`,
      phase: 'navigation',
      extras: {},
    };
  }
  if (executionKind === 'cancelled') {
    return {
      reasonCode: 'ptc_lab_browser_cancelled',
      message: `PTC lab browser ${PTC_LAB_BROWSER_USER_URL_NAVIGATION_SUBJECT} was cancelled`,
      phase: 'navigation',
      extras: {},
    };
  }
  if (executionKind === 'crash' || executionKind === 'output_limit_exceeded') {
    return {
      reasonCode: 'ptc_lab_browser_navigation_failed',
      message: `PTC lab browser ${PTC_LAB_BROWSER_USER_URL_NAVIGATION_SUBJECT} failed to execute`,
      phase: 'navigation',
      extras: { diagnostics: { commandResultKind: executionKind } },
    };
  }
  const exhausted: never = executionKind;
  return exhausted;
}

function mapUserUrlNavigationAdapterFailure(
  errorCode: UserUrlNavigationStdoutErrorCode,
): UserUrlNavigationAdapterFailureMapping {
  if (errorCode === 'cleanup_failed' || errorCode === 'cleanup_uncertain') {
    return {
      taintsSession: true,
      reasonCode:
        errorCode === 'cleanup_failed'
          ? 'ptc_lab_browser_cleanup_failed'
          : 'ptc_lab_browser_cleanup_uncertain',
      message: `PTC lab browser ${PTC_LAB_BROWSER_USER_URL_NAVIGATION_SUBJECT} cleanup was not proven`,
      phase: 'cleanup',
    };
  }

  return {
    taintsSession: false,
    reasonCode: mapUserUrlNavigationErrorCode(errorCode),
    message:
      errorCode === 'browser_runtime_unavailable'
        ? 'PTC lab browser runtime is unavailable'
        : `PTC lab browser ${PTC_LAB_BROWSER_USER_URL_NAVIGATION_SUBJECT} failed`,
    phase: mapUserUrlNavigationErrorPhase(errorCode),
  };
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
    isPtcRecord(value) &&
    typeof value.engineAvailable === 'boolean' &&
    typeof value.contextCreated === 'boolean' &&
    typeof value.navigationStarted === 'boolean' &&
    typeof value.navigationSettled === 'boolean' &&
    typeof value.redirectPolicyEnforced === 'boolean' &&
    typeof value.downloadPolicyEnforced === 'boolean' &&
    typeof value.cleanupCompleted === 'boolean'
  );
}
