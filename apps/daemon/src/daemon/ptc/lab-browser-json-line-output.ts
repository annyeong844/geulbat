import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  containsForbiddenBrowserOutputKey,
  containsForbiddenBrowserOutputValue,
  type PtcLabBrowserForbiddenOutputValueOptions,
} from './lab-browser-output-guard.js';

export type PtcLabBrowserJsonLineOutputAdmissionReason =
  | 'stdout_too_large'
  | 'stdout_not_one_json_line'
  | 'stdout_invalid_json'
  | 'stdout_forbidden_browser_output';

export type PtcLabBrowserJsonLineOutputAdmissionResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: PtcLabBrowserJsonLineOutputAdmissionReason };

export type PtcLabBrowserAdapterStdoutParseReason =
  | PtcLabBrowserJsonLineOutputAdmissionReason
  | 'stdout_invalid_shape'
  | 'stdout_invalid_result';

export type PtcLabBrowserAdapterStdoutParseResult<
  Checks,
  ErrorCode extends string,
> =
  | {
      ok: true;
      value:
        | { ok: true; checks: Checks }
        | { ok: false; checks: Checks; errorCode: ErrorCode };
    }
  | { ok: false; reason: PtcLabBrowserAdapterStdoutParseReason };

export interface PtcLabBrowserJsonLineOutputAdmissionArgs {
  extraForbiddenKeys?: readonly string[];
  forbidHtmlText?: boolean;
  forbidTargetHostname?: boolean;
  forbidTargetSearchAndHash?: boolean;
  maxStdoutBytes: number;
  stdout: string;
  targetUrl?: string;
}

export interface PtcLabBrowserAdapterStdoutParseArgs<
  Checks,
  ErrorCode extends string,
> extends PtcLabBrowserJsonLineOutputAdmissionArgs {
  capability: string;
  errorCodes: readonly ErrorCode[];
  isChecks: (value: unknown) => value is Checks;
}

export type PtcLabBrowserAdapterStdoutEnvelopeAdmissionReason =
  | PtcLabBrowserJsonLineOutputAdmissionReason
  | 'stdout_invalid_shape';

export type PtcLabBrowserAdapterStdoutEnvelopeAdmissionResult<Checks> =
  | {
      ok: true;
      value: {
        checks: Checks;
        parsed: Record<string, unknown>;
      };
    }
  | {
      ok: false;
      reason: PtcLabBrowserAdapterStdoutEnvelopeAdmissionReason;
    };

export interface PtcLabBrowserAdapterStdoutEnvelopeAdmissionArgs<
  Checks,
> extends PtcLabBrowserJsonLineOutputAdmissionArgs {
  capability: string;
  isChecks: (value: unknown) => value is Checks;
}

export function admitPtcLabBrowserJsonLineOutput(
  args: PtcLabBrowserJsonLineOutputAdmissionArgs,
): PtcLabBrowserJsonLineOutputAdmissionResult {
  if (Buffer.byteLength(args.stdout, 'utf8') > args.maxStdoutBytes) {
    return { ok: false, reason: 'stdout_too_large' };
  }

  const trimmed = args.stdout.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) {
    return { ok: false, reason: 'stdout_not_one_json_line' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'stdout_invalid_json' };
  }

  if (
    containsForbiddenBrowserOutputKey(
      parsed,
      args.extraForbiddenKeys === undefined
        ? {}
        : { extraForbiddenKeys: args.extraForbiddenKeys },
    ) ||
    containsForbiddenBrowserOutputValue({
      ...browserOutputValueOptions(args),
      value: parsed,
    })
  ) {
    return { ok: false, reason: 'stdout_forbidden_browser_output' };
  }

  return { ok: true, value: parsed };
}

export function admitPtcLabBrowserAdapterStdoutEnvelope<Checks>(
  args: PtcLabBrowserAdapterStdoutEnvelopeAdmissionArgs<Checks>,
): PtcLabBrowserAdapterStdoutEnvelopeAdmissionResult<Checks> {
  const admitted = admitPtcLabBrowserJsonLineOutput(args);
  if (!admitted.ok) {
    return admitted;
  }

  const parsed = admitted.value;
  if (
    !isRecord(parsed) ||
    parsed.capability !== args.capability ||
    !args.isChecks(parsed.checks)
  ) {
    return { ok: false, reason: 'stdout_invalid_shape' };
  }

  return {
    ok: true,
    value: {
      checks: parsed.checks,
      parsed,
    },
  };
}

export function parsePtcLabBrowserAdapterStdout<
  Checks,
  ErrorCode extends string,
>(
  args: PtcLabBrowserAdapterStdoutParseArgs<Checks, ErrorCode>,
): PtcLabBrowserAdapterStdoutParseResult<Checks, ErrorCode> {
  const admitted = admitPtcLabBrowserAdapterStdoutEnvelope(args);
  if (!admitted.ok) {
    return admitted;
  }

  const { checks, parsed } = admitted.value;

  if (parsed.ok === true) {
    return { ok: true, value: { ok: true, checks } };
  }

  if (
    parsed.ok === false &&
    typeof parsed.errorCode === 'string' &&
    includesAllowedErrorCode(args.errorCodes, parsed.errorCode)
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

  return { ok: false, reason: 'stdout_invalid_result' };
}

export function formatPtcLabBrowserAdapterStdoutParseFailure(args: {
  reason: PtcLabBrowserAdapterStdoutParseReason;
  subject: string;
}): string {
  if (args.reason === 'stdout_too_large') {
    return `PTC lab browser ${args.subject} stdout is too large`;
  }
  if (args.reason === 'stdout_not_one_json_line') {
    return `PTC lab browser ${args.subject} stdout must be one JSON line`;
  }
  if (args.reason === 'stdout_invalid_json') {
    return `PTC lab browser ${args.subject} stdout is not valid JSON`;
  }
  if (args.reason === 'stdout_invalid_shape') {
    return `PTC lab browser ${args.subject} stdout has invalid shape`;
  }
  if (args.reason === 'stdout_invalid_result') {
    return `PTC lab browser ${args.subject} stdout has invalid result`;
  }
  return `PTC lab browser ${args.subject} stdout contains forbidden browser output`;
}

function browserOutputValueOptions(
  args: PtcLabBrowserJsonLineOutputAdmissionArgs,
): Omit<PtcLabBrowserForbiddenOutputValueOptions, 'value'> {
  return {
    ...(args.forbidHtmlText === undefined
      ? {}
      : { forbidHtmlText: args.forbidHtmlText }),
    ...(args.forbidTargetHostname === undefined
      ? {}
      : { forbidTargetHostname: args.forbidTargetHostname }),
    ...(args.forbidTargetSearchAndHash === undefined
      ? {}
      : { forbidTargetSearchAndHash: args.forbidTargetSearchAndHash }),
    ...(args.targetUrl === undefined ? {} : { targetUrl: args.targetUrl }),
  };
}

function includesAllowedErrorCode<ErrorCode extends string>(
  errorCodes: readonly ErrorCode[],
  value: string,
): value is ErrorCode {
  for (const errorCode of errorCodes) {
    if (errorCode === value) {
      return true;
    }
  }
  return false;
}
