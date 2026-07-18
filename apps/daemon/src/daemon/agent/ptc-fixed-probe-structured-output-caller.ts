import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import type { PtcFixedEpochProbeRuntime } from '../daemon-runtime-contract.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  type PtcFixedEpochProbeRuntimeFailureReason,
  type PtcFixedEpochProbeRuntimeResult,
  type PtcFixedEpochProbeRuntimeSummary,
} from '../ptc/runtime/probes/fixed-probe-runtime-contract.js';
import type { RunContext } from '../run-context.js';
import { isRecord } from '../runtime-json.js';
import { composeAgentResult, type AgentResult } from './agent-result.js';

export const PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND =
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID;
export const PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID =
  'ptc-fixed-epoch-execution-probe-1' as const;

type PtcFixedProbeStructuredOutputCallerFailureReason =
  | 'structured_output_invalid'
  | 'structured_output_ambiguous'
  | 'structured_output_with_tool_calls'
  | PtcFixedEpochProbeRuntimeFailureReason;

type PtcFixedProbeStructuredOutputCallerResult =
  | {
      ok: true;
      result: AgentResult;
    }
  | {
      ok: false;
      reasonCode: PtcFixedProbeStructuredOutputCallerFailureReason;
      message: string;
      diagnostics?: PtcFixedProbeStructuredOutputCallerFailureDiagnostics;
    };

interface PtcFixedProbeStructuredOutputCallerFailureDiagnostics {
  underlyingReasonCode?: string;
  probeUnderlyingReasonCode?: string;
  bridgeReasonCode?: string;
  sessionReasonCode?: string;
  cleanupReasonCode?: string;
  probeErrorCode?: string;
  commandResultKind?: string;
  exitCode?: number;
  probeRuntimeThrew?: boolean;
}

export async function runPtcFixedProbeStructuredOutputCaller(args: {
  runContext: RunContext;
  runtime: PtcFixedEpochProbeRuntime;
  structuredOutputs: ProviderStructuredOutput[];
  functionCalls: FunctionCall[];
  signal?: AbortSignal;
}): Promise<PtcFixedProbeStructuredOutputCallerResult> {
  if (args.structuredOutputs.length > 1) {
    return fail(
      'structured_output_ambiguous',
      'structured_output_ambiguous: model returned multiple PTC fixed probe intents',
    );
  }

  if (args.structuredOutputs.length === 0) {
    return fail(
      'structured_output_invalid',
      'structured_output_invalid: PTC fixed probe intent is missing',
    );
  }

  if (args.functionCalls.length > 0) {
    return fail(
      'structured_output_with_tool_calls',
      'structured_output_with_tool_calls: PTC fixed probe intent cannot be mixed with tool calls',
    );
  }

  const structuredOutput = args.structuredOutputs[0];
  if (structuredOutput === undefined) {
    return fail(
      'structured_output_invalid',
      'structured_output_invalid: PTC fixed probe intent is missing',
    );
  }

  const request = readPtcFixedProbeRequest(structuredOutput);
  if (!request.ok) {
    return fail('structured_output_invalid', request.message);
  }

  const runtimeArgs = { runContext: args.runContext };
  const probe = await args.runtime.runFixedEpochProbe(
    args.signal === undefined
      ? runtimeArgs
      : { ...runtimeArgs, signal: args.signal },
  );
  if (!probe.ok) {
    return fail(
      probe.reasonCode,
      'ptc_fixed_epoch_execution_probe_failed: PTC fixed epoch execution probe failed',
      sanitizeProbeDiagnostics(probe),
    );
  }

  return {
    ok: true,
    result: composeAgentResult({
      ok: true,
      finalProse: formatPtcFixedProbeSummary(probe.value),
    }),
  };
}

function readPtcFixedProbeRequest(
  output: ProviderStructuredOutput,
): { ok: true } | { ok: false; message: string } {
  if (
    output.schemaVersion !== 1 ||
    output.kind !== PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND
  ) {
    return {
      ok: false,
      message: 'structured_output_invalid: unsupported PTC fixed probe intent',
    };
  }

  const payload = asRecord(output.payload);
  if (!payload) {
    return {
      ok: false,
      message:
        'structured_output_invalid: PTC fixed probe payload must be an object',
    };
  }

  if (Object.keys(payload).length !== 1) {
    return {
      ok: false,
      message:
        'structured_output_invalid: PTC fixed probe payload only accepts probeId',
    };
  }

  if (payload.probeId !== PTC_FIXED_PROBE_STRUCTURED_OUTPUT_PROBE_ID) {
    return {
      ok: false,
      message:
        'structured_output_invalid: PTC fixed probe payload requires the fixed probeId',
    };
  }

  return { ok: true };
}

function formatPtcFixedProbeSummary(
  summary: PtcFixedEpochProbeRuntimeSummary,
): string {
  return [
    'PTC fixed epoch execution probe completed.',
    `capabilityId: ${summary.capabilityId}`,
    `policyId: ${summary.policyId}`,
    `callbackRoundTrip: ${summary.callbackRoundTrip}`,
    `callbackResultKind: ${summary.callbackResultKind}`,
    `executionClass: ${summary.executionClass}`,
    `executionSurface: ${summary.executionSurface}`,
  ].join('\n');
}

function sanitizeProbeDiagnostics(
  result: Extract<PtcFixedEpochProbeRuntimeResult, { ok: false }>,
): PtcFixedProbeStructuredOutputCallerFailureDiagnostics {
  const safe: PtcFixedProbeStructuredOutputCallerFailureDiagnostics = {
    underlyingReasonCode: result.reasonCode,
  };
  const probeUnderlyingReasonCode = readStringDiagnostic(
    result.diagnostics,
    'underlyingReasonCode',
  );
  if (probeUnderlyingReasonCode !== undefined) {
    safe.probeUnderlyingReasonCode = probeUnderlyingReasonCode;
  }
  const bridgeReasonCode = readStringDiagnostic(
    result.diagnostics,
    'bridgeReasonCode',
  );
  if (bridgeReasonCode !== undefined) {
    safe.bridgeReasonCode = bridgeReasonCode;
  }
  const sessionReasonCode = readStringDiagnostic(
    result.diagnostics,
    'sessionReasonCode',
  );
  if (sessionReasonCode !== undefined) {
    safe.sessionReasonCode = sessionReasonCode;
  }
  const cleanupReasonCode = readStringDiagnostic(
    result.diagnostics,
    'cleanupReasonCode',
  );
  if (cleanupReasonCode !== undefined) {
    safe.cleanupReasonCode = cleanupReasonCode;
  }
  const probeErrorCode = readStringDiagnostic(
    result.diagnostics,
    'probeErrorCode',
  );
  if (probeErrorCode !== undefined) {
    safe.probeErrorCode = probeErrorCode;
  }
  const commandResultKind = readStringDiagnostic(
    result.diagnostics,
    'commandResultKind',
  );
  if (commandResultKind !== undefined) {
    safe.commandResultKind = commandResultKind;
  }
  const exitCode = readNumberDiagnostic(result.diagnostics, 'exitCode');
  if (exitCode !== undefined) {
    safe.exitCode = exitCode;
  }
  const probeRuntimeThrew = readBooleanDiagnostic(
    result.diagnostics,
    'probeRuntimeThrew',
  );
  if (probeRuntimeThrew !== undefined) {
    safe.probeRuntimeThrew = probeRuntimeThrew;
  }
  return safe;
}

function readStringDiagnostic(
  source: Record<string, string | number | boolean> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberDiagnostic(
  source: Record<string, string | number | boolean> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readBooleanDiagnostic(
  source: Record<string, string | number | boolean> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function fail(
  reasonCode: PtcFixedProbeStructuredOutputCallerFailureReason,
  message: string,
  diagnostics?: PtcFixedProbeStructuredOutputCallerFailureDiagnostics,
): Extract<PtcFixedProbeStructuredOutputCallerResult, { ok: false }> {
  return {
    ok: false,
    reasonCode,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
