import { definedPtcProps } from '../../../shared/record-shape.js';
import {
  PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
  type PtcLabBrowserTextEvidenceResult,
  browserTextEvidenceFailure,
} from './lab-browser-text-evidence-contract.js';
import { containsForbiddenBrowserTitle } from '../core/lab-browser-output-guard.js';
import {
  parsePtcLabBrowserTextValue,
  parsePtcLabBrowserEvidenceStdout,
  parsePtcLabBrowserSuccessfulEvidenceBase,
  type PtcLabBrowserEvidenceAdapterChecks,
  type PtcLabBrowserEvidenceStdoutFailure,
  type PtcLabBrowserSuccessfulEvidenceBase,
} from '../core/lab-browser-evidence-output.js';

const PTC_LAB_BROWSER_TEXT_EVIDENCE_LOAD_OUTCOMES = ['loaded'] as const;
const PTC_LAB_BROWSER_TEXT_EVIDENCE_LOAD_STATES = [
  'domcontentloaded',
  'load',
] as const;

type PtcLabBrowserTextEvidenceAdapterChecks =
  PtcLabBrowserEvidenceAdapterChecks;

type PtcLabBrowserTextEvidenceLoadOutcome =
  (typeof PTC_LAB_BROWSER_TEXT_EVIDENCE_LOAD_OUTCOMES)[number];
type PtcLabBrowserTextEvidenceLoadState =
  (typeof PTC_LAB_BROWSER_TEXT_EVIDENCE_LOAD_STATES)[number];

type ParsedTextEvidenceStdout =
  | (PtcLabBrowserSuccessfulEvidenceBase<
      PtcLabBrowserTextEvidenceLoadOutcome,
      PtcLabBrowserTextEvidenceLoadState
    > & {
      visibleText: string;
    })
  | PtcLabBrowserEvidenceStdoutFailure;

export function parseTextEvidenceStdout(args: {
  stdout: string;
  targetUrl: string;
}): PtcLabBrowserTextEvidenceResult<ParsedTextEvidenceStdout> {
  return parsePtcLabBrowserEvidenceStdout({
    capability: PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    stdout: args.stdout,
    subject: 'text evidence',
    targetUrl: args.targetUrl,
    outputInvalid,
    parseSuccessfulEvidence: ({ checks, parsed }) =>
      parseSuccessfulEvidence({
        checks,
        parsed,
        targetUrl: args.targetUrl,
      }),
  });
}

function parseSuccessfulEvidence(args: {
  checks: PtcLabBrowserTextEvidenceAdapterChecks;
  parsed: Record<string, unknown>;
  targetUrl: string;
}): PtcLabBrowserTextEvidenceResult<
  Extract<ParsedTextEvidenceStdout, { ok: true }>
> {
  const base = parsePtcLabBrowserSuccessfulEvidenceBase({
    checks: args.checks,
    invalidMessage:
      'PTC lab browser text evidence stdout has invalid evidence fields',
    loadOutcomes: PTC_LAB_BROWSER_TEXT_EVIDENCE_LOAD_OUTCOMES,
    loadStates: PTC_LAB_BROWSER_TEXT_EVIDENCE_LOAD_STATES,
    outputInvalid,
    parsed: args.parsed,
  });
  if (!base.ok) {
    return base;
  }
  const visibleText = parseVisibleText({
    value: args.parsed.visibleText,
    targetUrl: args.targetUrl,
  });
  if (!visibleText.ok) {
    return visibleText;
  }

  return {
    ok: true,
    value: {
      ok: true,
      checks: args.checks,
      loadOutcome: base.loadOutcome,
      loadState: base.loadState,
      finalUrlDigest: base.finalUrlDigest,
      visibleText: visibleText.value,
      redirectCount: base.redirectCount,
      ...definedPtcProps({
        navigationDurationMs: base.navigationDurationMs,
      }),
    },
  };
}

function parseVisibleText(args: {
  value: unknown;
  targetUrl: string;
}): PtcLabBrowserTextEvidenceResult<string> {
  return parsePtcLabBrowserTextValue({
    value: args.value,
    invalidMessage:
      'PTC lab browser text evidence stdout has invalid visible text evidence',
    outputInvalid,
    containsForbiddenText: (value) =>
      containsForbiddenBrowserTitle({
        targetUrl: args.targetUrl,
        value,
      }),
  });
}

function outputInvalid(
  message: string,
): Extract<PtcLabBrowserTextEvidenceResult<never>, { ok: false }> {
  return browserTextEvidenceFailure(
    'ptc_lab_browser_evidence_output_invalid',
    message,
    'output_serialization',
  );
}
