import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  type PtcLabBrowserPageLoadEvidenceChecks,
  type PtcLabBrowserPageLoadEvidenceResult,
  browserPageLoadEvidenceFailure,
} from './lab-browser-page-load-evidence-contract.js';
import {
  admitPtcLabBrowserAdapterStdoutEnvelope,
  formatPtcLabBrowserAdapterStdoutParseFailure,
} from './lab-browser-json-line-output.js';
import { containsForbiddenBrowserTitle } from './lab-browser-output-guard.js';

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_MAX_STDOUT_BYTES = 8 * 1024;

export type PtcLabBrowserPageLoadEvidenceAdapterChecks = Omit<
  PtcLabBrowserPageLoadEvidenceChecks,
  'targetVerified'
>;

export type ParsedPageLoadEvidenceStdout =
  | {
      ok: true;
      checks: PtcLabBrowserPageLoadEvidenceAdapterChecks;
      loadOutcome: 'loaded' | 'no_committed_document' | 'browser_error_page';
      loadState: 'domcontentloaded' | 'load' | 'no_committed_document';
      finalUrlDigest: `sha256:${string}`;
      responseStatus?: {
        code: number;
        source: 'final_main_resource_response';
      };
      title?: {
        text: string;
        charCount: number;
        truncated: boolean;
        maxChars: number;
        redacted: boolean;
      };
      redirectCount: number;
      navigationDurationMs?: number;
    }
  | {
      ok: false;
      checks: PtcLabBrowserPageLoadEvidenceAdapterChecks;
      errorCode:
        | 'browser_runtime_unavailable'
        | 'navigation_failed'
        | 'redirect_disallowed'
        | 'download_disallowed'
        | 'popup_disallowed'
        | 'permission_disallowed'
        | 'evidence_unavailable'
        | 'evidence_output_invalid'
        | 'cleanup_failed'
        | 'cleanup_uncertain';
    };

const PAGE_LOAD_EVIDENCE_STDOUT_ERROR_CODES = [
  'browser_runtime_unavailable',
  'navigation_failed',
  'redirect_disallowed',
  'download_disallowed',
  'popup_disallowed',
  'permission_disallowed',
  'evidence_unavailable',
  'evidence_output_invalid',
  'cleanup_failed',
  'cleanup_uncertain',
] as const satisfies readonly Extract<
  ParsedPageLoadEvidenceStdout,
  { ok: false }
>['errorCode'][];

export function parsePageLoadEvidenceStdout(args: {
  stdout: string;
  targetUrl: string;
  maxTitleChars: number;
}): PtcLabBrowserPageLoadEvidenceResult<ParsedPageLoadEvidenceStdout> {
  const admitted = admitPtcLabBrowserAdapterStdoutEnvelope({
    capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
    forbidHtmlText: true,
    forbidTargetSearchAndHash: true,
    isChecks,
    maxStdoutBytes: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_MAX_STDOUT_BYTES,
    stdout: args.stdout,
    targetUrl: args.targetUrl,
  });
  if (!admitted.ok) {
    return outputInvalid(
      formatPtcLabBrowserAdapterStdoutParseFailure({
        reason: admitted.reason,
        subject: 'page-load evidence',
      }),
    );
  }
  const { checks, parsed } = admitted.value;
  if (parsed.ok === true) {
    const evidence = parseSuccessfulEvidence({
      parsed,
      maxTitleChars: args.maxTitleChars,
    });
    return evidence.ok ? { ok: true, value: evidence.value } : evidence;
  }
  if (
    parsed.ok === false &&
    typeof parsed.errorCode === 'string' &&
    includesPageLoadEvidenceErrorCode(parsed.errorCode)
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
  return outputInvalid(
    'PTC lab browser page-load evidence stdout has invalid result',
  );
}

function parseSuccessfulEvidence(args: {
  parsed: Record<string, unknown>;
  maxTitleChars: number;
}): PtcLabBrowserPageLoadEvidenceResult<
  Extract<ParsedPageLoadEvidenceStdout, { ok: true }>
> {
  const { parsed } = args;
  if (
    (parsed.loadOutcome !== 'loaded' &&
      parsed.loadOutcome !== 'no_committed_document' &&
      parsed.loadOutcome !== 'browser_error_page') ||
    (parsed.loadState !== 'domcontentloaded' &&
      parsed.loadState !== 'load' &&
      parsed.loadState !== 'no_committed_document') ||
    !isSha256Digest(parsed.finalUrlDigest) ||
    !isNonNegativeInteger(parsed.redirectCount) ||
    (parsed.navigationDurationMs !== undefined &&
      !isNonNegativeInteger(parsed.navigationDurationMs))
  ) {
    return outputInvalid(
      'PTC lab browser page-load evidence stdout has invalid evidence fields',
    );
  }
  const responseStatus = parseResponseStatus(parsed.responseStatus);
  if (!responseStatus.ok) {
    return responseStatus;
  }
  const title = parseTitle({
    value: parsed.title,
    maxTitleChars: args.maxTitleChars,
  });
  if (!title.ok) {
    return title;
  }

  return {
    ok: true,
    value: {
      ok: true,
      checks: parsed.checks as PtcLabBrowserPageLoadEvidenceAdapterChecks,
      loadOutcome: parsed.loadOutcome,
      loadState: parsed.loadState,
      finalUrlDigest: parsed.finalUrlDigest,
      ...(responseStatus.value === undefined
        ? {}
        : { responseStatus: responseStatus.value }),
      ...(title.value === undefined ? {} : { title: title.value }),
      redirectCount: parsed.redirectCount,
      ...(parsed.navigationDurationMs === undefined
        ? {}
        : { navigationDurationMs: parsed.navigationDurationMs }),
    },
  };
}

function parseResponseStatus(
  value: unknown,
): PtcLabBrowserPageLoadEvidenceResult<
  | {
      code: number;
      source: 'final_main_resource_response';
    }
  | undefined
> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return outputInvalid(
      'PTC lab browser page-load evidence stdout has invalid response status',
    );
  }
  const code = value.code;
  const source = value.source;
  if (
    typeof code !== 'number' ||
    !Number.isInteger(code) ||
    code < 100 ||
    code > 599 ||
    source !== 'final_main_resource_response'
  ) {
    return outputInvalid(
      'PTC lab browser page-load evidence stdout has invalid response status',
    );
  }
  return {
    ok: true,
    value: {
      code,
      source,
    },
  };
}

function parseTitle(args: {
  value: unknown;
  maxTitleChars: number;
}): PtcLabBrowserPageLoadEvidenceResult<
  | {
      text: string;
      charCount: number;
      truncated: boolean;
      maxChars: number;
      redacted: boolean;
    }
  | undefined
> {
  if (args.value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(args.value)) {
    return outputInvalid(
      'PTC lab browser page-load evidence stdout has invalid title evidence',
    );
  }
  const text = args.value.text;
  const charCount = args.value.charCount;
  const truncated = args.value.truncated;
  const maxChars = args.value.maxChars;
  const redacted = args.value.redacted;
  if (
    typeof text !== 'string' ||
    typeof charCount !== 'number' ||
    !Number.isInteger(charCount) ||
    charCount < 0 ||
    typeof truncated !== 'boolean' ||
    maxChars !== args.maxTitleChars ||
    typeof redacted !== 'boolean' ||
    text.length > args.maxTitleChars ||
    containsForbiddenBrowserTitle({ value: text })
  ) {
    return outputInvalid(
      'PTC lab browser page-load evidence stdout has invalid title evidence',
    );
  }
  return {
    ok: true,
    value: {
      text,
      charCount,
      truncated,
      maxChars,
      redacted,
    },
  };
}

function outputInvalid(
  message: string,
): PtcLabBrowserPageLoadEvidenceResult<never> {
  return browserPageLoadEvidenceFailure(
    'ptc_lab_browser_evidence_output_invalid',
    message,
    'output_serialization',
  );
}

function isChecks(
  value: unknown,
): value is PtcLabBrowserPageLoadEvidenceAdapterChecks {
  return (
    isRecord(value) &&
    typeof value.engineAvailable === 'boolean' &&
    typeof value.contextCreated === 'boolean' &&
    typeof value.navigationStarted === 'boolean' &&
    typeof value.navigationSettled === 'boolean' &&
    typeof value.redirectPolicyEnforced === 'boolean' &&
    typeof value.downloadPolicyEnforced === 'boolean' &&
    typeof value.popupPolicyEnforced === 'boolean' &&
    typeof value.permissionPolicyEnforced === 'boolean' &&
    typeof value.evidenceSanitized === 'boolean' &&
    typeof value.cleanupCompleted === 'boolean'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function includesPageLoadEvidenceErrorCode(
  value: string,
): value is Extract<ParsedPageLoadEvidenceStdout, { ok: false }>['errorCode'] {
  for (const errorCode of PAGE_LOAD_EVIDENCE_STDOUT_ERROR_CODES) {
    if (errorCode === value) {
      return true;
    }
  }
  return false;
}
