export const PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID =
  'ptc_fixed_epoch_execution_probe' as const;
export const PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID =
  'ptc_fixed_epoch_execution_probe_v1' as const;

export type PtcFixedProbeDiagnostics = Record<
  string,
  string | number | boolean
>;

type PtcFixedEpochExecutionProbeFailureReason =
  | 'bridge_unavailable'
  | 'probe_input_write_failed'
  | 'execution_failed'
  | 'probe_output_invalid'
  | 'probe_result_failed';

export type PtcFixedEpochExecutionProbeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcFixedEpochExecutionProbeFailureReason;
      message: string;
      diagnostics?: PtcFixedProbeDiagnostics;
    };

export interface PtcFixedEpochExecutionProbeSummary {
  ok: true;
  capabilityId: typeof PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID;
  policyId: typeof PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID;
  executionClass: 'fixed_docker_exec_probe';
  executionSurface: 'baked_image_node_eval';
  containerId: string;
  epochId: string;
  callbackRoundTrip: 'observed';
  callbackResultKind: 'inline' | 'offloaded' | 'other';
  exitCode: 0;
}

export type PtcFixedEpochProbeRuntimeFailureReason =
  | PtcFixedEpochExecutionProbeFailureReason
  | 'session_cleanup_failed';

export type PtcFixedEpochProbeRuntimeSummary =
  PtcFixedEpochExecutionProbeSummary;

export type PtcFixedEpochProbeRuntimeResult =
  | { ok: true; value: PtcFixedEpochProbeRuntimeSummary }
  | {
      ok: false;
      reasonCode: PtcFixedEpochProbeRuntimeFailureReason;
      message: string;
      diagnostics?: PtcFixedProbeDiagnostics;
    };
