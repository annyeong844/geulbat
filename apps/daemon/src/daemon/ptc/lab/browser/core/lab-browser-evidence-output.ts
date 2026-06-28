import { definedPtcProps, isPtcRecord } from '../../../shared/record-shape.js';
import {
  admitPtcLabBrowserAdapterStdoutEnvelope,
  formatPtcLabBrowserAdapterStdoutParseFailure,
} from './lab-browser-json-line-output.js';
import type {
  PtcLabBrowserEvidenceAdapterChecks,
  PtcLabBrowserEvidenceDigest,
} from '../../../shared/browser-evidence-contract.js';
import type { PtcLabBrowserEvidenceAdapterFailureCode } from './lab-browser-result-contract.js';

export type { PtcLabBrowserEvidenceAdapterChecks };

const PTC_LAB_BROWSER_EVIDENCE_STDOUT_ERROR_CODES = [
  'browser_runtime_unavailable',
  'navigation_failed',
  'redirect_disallowed',
  'download_disallowed',
  'popup_disallowed',
  'evidence_unavailable',
  'evidence_output_invalid',
  'cleanup_failed',
  'cleanup_uncertain',
] as const satisfies readonly PtcLabBrowserEvidenceAdapterFailureCode[];

export interface PtcLabBrowserEvidenceStdoutFailure {
  ok: false;
  checks: PtcLabBrowserEvidenceAdapterChecks;
  errorCode: PtcLabBrowserEvidenceAdapterFailureCode;
}

export interface PtcLabBrowserSuccessfulEvidenceBase<
  LoadOutcome extends string,
  LoadState extends string,
> {
  ok: true;
  checks: PtcLabBrowserEvidenceAdapterChecks;
  loadOutcome: LoadOutcome;
  loadState: LoadState;
  finalUrlDigest: PtcLabBrowserEvidenceDigest;
  redirectCount: number;
  navigationDurationMs?: number;
}

type PtcLabBrowserEvidenceStdoutAdmission =
  | {
      ok: true;
      value:
        | {
            ok: true;
            checks: PtcLabBrowserEvidenceAdapterChecks;
            parsed: Record<string, unknown>;
          }
        | PtcLabBrowserEvidenceStdoutFailure;
    }
  | {
      ok: false;
      message: string;
    };

interface ParsePtcLabBrowserTextValueArgs<Failure> {
  value: unknown;
  invalidMessage: string;
  outputInvalid: (message: string) => Failure;
  containsForbiddenText?: (value: string) => boolean;
}

export function parsePtcLabBrowserEvidenceStdout<
  Success,
  Failure extends { ok: false },
>(args: {
  capability: string;
  stdout: string;
  subject: string;
  targetUrl: string;
  outputInvalid: (message: string) => Failure;
  parseSuccessfulEvidence: (args: {
    checks: PtcLabBrowserEvidenceAdapterChecks;
    parsed: Record<string, unknown>;
  }) => { ok: true; value: Success } | Failure;
}):
  | { ok: true; value: Success | PtcLabBrowserEvidenceStdoutFailure }
  | Failure {
  const admitted = admitPtcLabBrowserEvidenceStdout({
    capability: args.capability,
    stdout: args.stdout,
    subject: args.subject,
    targetUrl: args.targetUrl,
  });
  if (!admitted.ok) {
    return args.outputInvalid(admitted.message);
  }
  if (admitted.value.ok === true) {
    const evidence = args.parseSuccessfulEvidence({
      checks: admitted.value.checks,
      parsed: admitted.value.parsed,
    });
    return evidence.ok ? { ok: true, value: evidence.value } : evidence;
  }
  return { ok: true, value: admitted.value };
}

export function parsePtcLabBrowserTextValue<Failure extends { ok: false }>(
  args: ParsePtcLabBrowserTextValueArgs<Failure> & {
    allowMissing: true;
  },
): { ok: true; value: string | undefined } | Failure;
export function parsePtcLabBrowserTextValue<Failure extends { ok: false }>(
  args: ParsePtcLabBrowserTextValueArgs<Failure> & {
    allowMissing?: false;
  },
): { ok: true; value: string } | Failure;
export function parsePtcLabBrowserTextValue<Failure extends { ok: false }>(
  args: ParsePtcLabBrowserTextValueArgs<Failure> & {
    allowMissing?: boolean;
  },
): { ok: true; value: string | undefined } | Failure {
  if (args.value === undefined && args.allowMissing === true) {
    return { ok: true, value: undefined };
  }
  if (
    typeof args.value !== 'string' ||
    (args.containsForbiddenText?.(args.value) ?? false)
  ) {
    return args.outputInvalid(args.invalidMessage);
  }
  return {
    ok: true,
    value: args.value,
  };
}

function admitPtcLabBrowserEvidenceStdout(args: {
  capability: string;
  stdout: string;
  subject: string;
  targetUrl: string;
}): PtcLabBrowserEvidenceStdoutAdmission {
  const admitted = admitPtcLabBrowserAdapterStdoutEnvelope({
    capability: args.capability,
    forbidHtmlText: true,
    forbidTargetSearchAndHash: true,
    isChecks: isPtcLabBrowserEvidenceAdapterChecks,
    stdout: args.stdout,
    targetUrl: args.targetUrl,
  });
  if (!admitted.ok) {
    return {
      ok: false,
      message: formatPtcLabBrowserAdapterStdoutParseFailure({
        reason: admitted.reason,
        subject: args.subject,
      }),
    };
  }

  const { checks, parsed } = admitted.value;
  if (parsed.ok === true) {
    return {
      ok: true,
      value: {
        ok: true,
        checks,
        parsed,
      },
    };
  }

  if (
    parsed.ok === false &&
    typeof parsed.errorCode === 'string' &&
    isPtcLabBrowserEvidenceStdoutErrorCode(parsed.errorCode)
  ) {
    return {
      ok: true,
      value: {
        ok: false,
        checks,
        errorCode: parsed.errorCode,
      },
    };
  }

  return {
    ok: false,
    message: formatPtcLabBrowserAdapterStdoutParseFailure({
      reason: 'stdout_invalid_result',
      subject: args.subject,
    }),
  };
}

function isPtcLabBrowserEvidenceStdoutErrorCode(
  value: string,
): value is PtcLabBrowserEvidenceAdapterFailureCode {
  for (const errorCode of PTC_LAB_BROWSER_EVIDENCE_STDOUT_ERROR_CODES) {
    if (errorCode === value) {
      return true;
    }
  }
  return false;
}

export function parsePtcLabBrowserSuccessfulEvidenceBase<
  LoadOutcome extends string,
  LoadState extends string,
  Failure extends { ok: false },
>(args: {
  checks: PtcLabBrowserEvidenceAdapterChecks;
  invalidMessage: string;
  loadOutcomes: readonly LoadOutcome[];
  loadStates: readonly LoadState[];
  outputInvalid: (message: string) => Failure;
  parsed: Record<string, unknown>;
}): PtcLabBrowserSuccessfulEvidenceBase<LoadOutcome, LoadState> | Failure {
  const loadOutcome = args.parsed.loadOutcome;
  const loadState = args.parsed.loadState;
  const finalUrlDigest = args.parsed.finalUrlDigest;
  const redirectCount = args.parsed.redirectCount;
  const navigationDurationMs = args.parsed.navigationDurationMs;
  if (
    !isAllowedPtcLabBrowserEvidenceLiteral(loadOutcome, args.loadOutcomes) ||
    !isAllowedPtcLabBrowserEvidenceLiteral(loadState, args.loadStates) ||
    !isPtcLabBrowserSha256Digest(finalUrlDigest) ||
    !isPtcLabBrowserNonNegativeInteger(redirectCount) ||
    (navigationDurationMs !== undefined &&
      !isPtcLabBrowserNonNegativeInteger(navigationDurationMs))
  ) {
    return args.outputInvalid(args.invalidMessage);
  }
  return {
    ok: true,
    checks: args.checks,
    loadOutcome,
    loadState,
    finalUrlDigest,
    redirectCount,
    ...definedPtcProps({ navigationDurationMs }),
  };
}

function isPtcLabBrowserEvidenceAdapterChecks(
  value: unknown,
): value is PtcLabBrowserEvidenceAdapterChecks {
  return (
    isPtcRecord(value) &&
    typeof value.engineAvailable === 'boolean' &&
    typeof value.contextCreated === 'boolean' &&
    typeof value.navigationStarted === 'boolean' &&
    typeof value.navigationSettled === 'boolean' &&
    typeof value.redirectPolicyEnforced === 'boolean' &&
    typeof value.downloadPolicyEnforced === 'boolean' &&
    typeof value.popupPolicyEnforced === 'boolean' &&
    typeof value.evidenceCaptured === 'boolean' &&
    typeof value.cleanupCompleted === 'boolean'
  );
}

function isPtcLabBrowserNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function isPtcLabBrowserSha256Digest(
  value: unknown,
): value is PtcLabBrowserEvidenceDigest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isAllowedPtcLabBrowserEvidenceLiteral<Value extends string>(
  value: unknown,
  allowedValues: readonly Value[],
): value is Value {
  for (const allowedValue of allowedValues) {
    if (value === allowedValue) {
      return true;
    }
  }
  return false;
}
