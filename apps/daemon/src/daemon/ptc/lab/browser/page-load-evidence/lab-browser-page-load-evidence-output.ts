import { definedPtcProps, isPtcRecord } from '../../../shared/record-shape.js';
import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  type PtcLabBrowserPageLoadEvidenceResult,
  browserPageLoadEvidenceFailure,
} from './lab-browser-page-load-evidence-contract.js';
import { containsForbiddenBrowserTitle } from '../core/lab-browser-output-guard.js';
import {
  parsePtcLabBrowserTextValue,
  parsePtcLabBrowserEvidenceStdout,
  parsePtcLabBrowserSuccessfulEvidenceBase,
  type PtcLabBrowserEvidenceAdapterChecks,
  type PtcLabBrowserEvidenceStdoutFailure,
  type PtcLabBrowserSuccessfulEvidenceBase,
} from '../core/lab-browser-evidence-output.js';

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_LOAD_OUTCOMES = [
  'loaded',
  'no_committed_document',
  'browser_error_page',
] as const;
const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_LOAD_STATES = [
  'domcontentloaded',
  'load',
  'no_committed_document',
] as const;

type PtcLabBrowserPageLoadEvidenceAdapterChecks =
  PtcLabBrowserEvidenceAdapterChecks;

type PtcLabBrowserPageLoadEvidenceLoadOutcome =
  (typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_LOAD_OUTCOMES)[number];
type PtcLabBrowserPageLoadEvidenceLoadState =
  (typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_LOAD_STATES)[number];

type ParsedPageLoadEvidenceStdout =
  | (PtcLabBrowserSuccessfulEvidenceBase<
      PtcLabBrowserPageLoadEvidenceLoadOutcome,
      PtcLabBrowserPageLoadEvidenceLoadState
    > & {
      responseStatus?: {
        code: number;
        source: 'final_main_resource_response';
      };
      title?: string;
    })
  | PtcLabBrowserEvidenceStdoutFailure;

export function parsePageLoadEvidenceStdout(args: {
  stdout: string;
  targetUrl: string;
}): PtcLabBrowserPageLoadEvidenceResult<ParsedPageLoadEvidenceStdout> {
  return parsePtcLabBrowserEvidenceStdout({
    capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
    stdout: args.stdout,
    subject: 'page-load evidence',
    targetUrl: args.targetUrl,
    outputInvalid,
    parseSuccessfulEvidence: ({ checks, parsed }) =>
      parseSuccessfulEvidence({
        checks,
        parsed,
      }),
  });
}

function parseSuccessfulEvidence(args: {
  checks: PtcLabBrowserPageLoadEvidenceAdapterChecks;
  parsed: Record<string, unknown>;
}): PtcLabBrowserPageLoadEvidenceResult<
  Extract<ParsedPageLoadEvidenceStdout, { ok: true }>
> {
  const base = parsePtcLabBrowserSuccessfulEvidenceBase({
    checks: args.checks,
    invalidMessage:
      'PTC lab browser page-load evidence stdout has invalid evidence fields',
    loadOutcomes: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_LOAD_OUTCOMES,
    loadStates: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_LOAD_STATES,
    outputInvalid,
    parsed: args.parsed,
  });
  if (!base.ok) {
    return base;
  }
  const { parsed } = args;
  const responseStatus = parseResponseStatus(parsed.responseStatus);
  if (!responseStatus.ok) {
    return responseStatus;
  }
  const title = parseTitle({
    value: parsed.title,
  });
  if (!title.ok) {
    return title;
  }

  return {
    ok: true,
    value: {
      ok: true,
      checks: args.checks,
      loadOutcome: base.loadOutcome,
      loadState: base.loadState,
      finalUrlDigest: base.finalUrlDigest,
      redirectCount: base.redirectCount,
      ...definedPtcProps({
        responseStatus: responseStatus.value,
        title: title.value,
        navigationDurationMs: base.navigationDurationMs,
      }),
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
  if (!isPtcRecord(value)) {
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
}): PtcLabBrowserPageLoadEvidenceResult<string | undefined> {
  return parsePtcLabBrowserTextValue({
    value: args.value,
    allowMissing: true,
    invalidMessage:
      'PTC lab browser page-load evidence stdout has invalid title evidence',
    outputInvalid,
    containsForbiddenText: (value) => containsForbiddenBrowserTitle({ value }),
  });
}

function outputInvalid(
  message: string,
): Extract<PtcLabBrowserPageLoadEvidenceResult<never>, { ok: false }> {
  return browserPageLoadEvidenceFailure(
    'ptc_lab_browser_evidence_output_invalid',
    message,
    'output_serialization',
  );
}
