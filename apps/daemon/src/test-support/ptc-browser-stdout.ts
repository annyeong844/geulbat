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
