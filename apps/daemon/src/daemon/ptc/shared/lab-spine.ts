export type PtcFailureDiagnostics = Record<string, string | number | boolean>;

export type PtcFailureResult<ReasonCode extends string> = {
  ok: false;
  reasonCode: ReasonCode;
  message: string;
  diagnostics?: PtcFailureDiagnostics;
};

export type PtcBoundedTimeoutAdmission =
  | { ok: true; value: number }
  | { ok: false };

export type PtcLabPolicyAdmission<LabPolicy> =
  | { ok: true; value: LabPolicy }
  | { ok: false };

export function admitPtcLabPolicy<LabPolicy>(
  admission:
    | {
        metadata: { selectedProfile: unknown };
        labPolicy?: LabPolicy | undefined;
      }
    | undefined,
): PtcLabPolicyAdmission<LabPolicy> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return { ok: false };
  }
  return { ok: true, value: admission.labPolicy };
}

export function admitPtcBoundedTimeoutMs(args: {
  timeoutMs: unknown;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}): PtcBoundedTimeoutAdmission {
  const timeoutMs = args.timeoutMs ?? args.defaultTimeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > args.maxTimeoutMs
  ) {
    return { ok: false };
  }
  return { ok: true, value: timeoutMs };
}

export function ptcFailure<ReasonCode extends string>(
  reasonCode: ReasonCode,
  message: string,
  diagnostics?: PtcFailureDiagnostics,
): PtcFailureResult<ReasonCode> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}
