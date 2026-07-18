export type PtcBrowserAdapterStdoutArgs<Checks, ErrorCode extends string> =
  | {
      ok: true;
      capability: string;
      checks: Checks;
      successFields?: Record<string, unknown>;
    }
  | {
      ok: false;
      capability: string;
      checks: Checks;
      errorCode: ErrorCode;
    };

export interface PtcBrowserEvidenceSuccessStdoutArgs<Checks> {
  capability: string;
  checks: Checks;
  finalUrlDigest?: `sha256:${string}`;
  evidenceFields?: Record<string, unknown>;
  redirectCount?: number;
  navigationDurationMs?: number;
}

export function ptcBrowserAdapterStdout<
  Checks,
  ErrorCode extends string = never,
>(args: PtcBrowserAdapterStdoutArgs<Checks, ErrorCode>): string {
  return `${JSON.stringify({
    ok: args.ok,
    capability: args.capability,
    checks: args.checks,
    ...(args.ok ? (args.successFields ?? {}) : { errorCode: args.errorCode }),
  })}\n`;
}

export function ptcBrowserEvidenceSuccessStdout<Checks>(
  args: PtcBrowserEvidenceSuccessStdoutArgs<Checks>,
): string {
  return ptcBrowserAdapterStdout({
    ok: true,
    capability: args.capability,
    checks: args.checks,
    successFields: {
      loadOutcome: 'loaded',
      loadState: 'domcontentloaded',
      finalUrlDigest:
        args.finalUrlDigest ??
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ...(args.evidenceFields ?? {}),
      redirectCount: args.redirectCount ?? 0,
      navigationDurationMs: args.navigationDurationMs ?? 37,
    },
  });
}
