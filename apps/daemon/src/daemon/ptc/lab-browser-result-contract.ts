export type PtcLabBrowserDiagnostics = Record<
  string,
  string | number | boolean
>;

export interface PtcLabBrowserFailure<ReasonCode extends string> {
  ok: false;
  reasonCode: ReasonCode;
  message: string;
  diagnostics?: PtcLabBrowserDiagnostics;
}

export type PtcLabBrowserResult<T, Failure> = { ok: true; value: T } | Failure;

export type PtcLabBrowserSimpleResult<
  T,
  ReasonCode extends string,
> = PtcLabBrowserResult<T, PtcLabBrowserFailure<ReasonCode>>;

export type PtcLabBrowserPhasedFailure<
  Kind extends string,
  ReasonCode extends string,
  Phase extends string,
  Extras extends object = Record<never, never>,
> = PtcLabBrowserFailure<ReasonCode> & {
  kind: Kind;
  phase: Phase;
} & Extras;

export function createPtcLabBrowserFailure<ReasonCode extends string>(
  reasonCode: ReasonCode,
  message: string,
  diagnostics?: PtcLabBrowserDiagnostics,
): PtcLabBrowserFailure<ReasonCode> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}

export function createPtcLabBrowserPhasedFailure<
  Kind extends string,
  ReasonCode extends string,
  Phase extends string,
  Extras extends object = Record<never, never>,
>(args: {
  kind: Kind;
  reasonCode: ReasonCode;
  message: string;
  phase: Phase;
  extras?: Extras;
}): PtcLabBrowserPhasedFailure<Kind, ReasonCode, Phase, Extras> {
  return {
    ...args.extras,
    kind: args.kind,
    ok: false,
    reasonCode: args.reasonCode,
    message: args.message,
    phase: args.phase,
  } as PtcLabBrowserPhasedFailure<Kind, ReasonCode, Phase, Extras>;
}
