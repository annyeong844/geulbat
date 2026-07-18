import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import type { SandboxAttemptStore } from '../sandbox/attempt-store.js';
import { isOpaqueSandboxOutputEvidenceRef } from '../sandbox/output-validation.js';
import { decodeReactBundleDependencyPrepareRequest } from '../react-bundle-dependency-admission/react-bundle-dependency-prepare.js';
import {
  runReactBundleExplicitCdnArtifactIngress,
  type ReactBundleExplicitCdnArtifactIngressFailureReason,
  type ReactBundleExplicitCdnArtifactIngressRequest,
  type ReactBundleExplicitCdnArtifactIngressResult,
} from './react-bundle-explicit-cdn-artifact-ingress.js';
import type { AgentResult } from './agent-result.js';
import type { ReactBundleStructuredOutputIngressPolicy } from './react-bundle-structured-output-ingress-policy.js';

type ReactBundleStructuredOutputCallerFailureReason =
  | 'structured_output_invalid'
  | 'structured_output_ambiguous'
  | 'structured_output_with_tool_calls'
  | ReactBundleExplicitCdnArtifactIngressFailureReason;

export type ReactBundleStructuredOutputCallerResult =
  | {
      ok: true;
      result: AgentResult;
    }
  | {
      ok: false;
      reasonCode: ReactBundleStructuredOutputCallerFailureReason;
      message: string;
      diagnostics?: {
        prepareEvidenceRef?: string;
        probeEvidenceRef?: string;
        underlyingReasonCode?: string;
      };
    };

type FailureDiagnostics = Extract<
  ReactBundleStructuredOutputCallerResult,
  { ok: false }
>['diagnostics'];

type RunIngress = typeof runReactBundleExplicitCdnArtifactIngress;

export async function runReactBundleStructuredOutputCaller(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  structuredOutputs: ProviderStructuredOutput[];
  functionCalls: FunctionCall[];
  ingressPolicy?: ReactBundleStructuredOutputIngressPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => string;
  probeTransport?: Parameters<RunIngress>[0]['probeTransport'];
  runIngress?: RunIngress;
}): Promise<ReactBundleStructuredOutputCallerResult> {
  if (args.structuredOutputs.length > 1) {
    return fail(
      'structured_output_ambiguous',
      'structured_output_ambiguous: model returned multiple structured artifact intents',
    );
  }

  if (args.structuredOutputs.length === 0) {
    return fail(
      'structured_output_invalid',
      'structured_output_invalid: structured artifact intent is missing',
    );
  }

  if (args.functionCalls.length > 0) {
    return fail(
      'structured_output_with_tool_calls',
      'structured_output_with_tool_calls: structured artifact intent cannot be mixed with tool calls',
    );
  }

  const structuredOutput = args.structuredOutputs[0];
  if (structuredOutput === undefined) {
    return fail(
      'structured_output_invalid',
      'structured_output_invalid: structured artifact intent is missing',
    );
  }

  const request = readReactBundleExplicitCdnRequest(structuredOutput);
  if (!request.ok) {
    return fail('structured_output_invalid', request.message);
  }

  const runIngress =
    args.runIngress ?? runReactBundleExplicitCdnArtifactIngress;
  const ingressArgs: Parameters<RunIngress>[0] = {
    workspaceRoot: args.workspaceRoot,
    store: args.store,
    request: request.value,
  };
  const timeoutMs = args.timeoutMs ?? args.ingressPolicy?.timeoutMs;
  if (timeoutMs !== undefined) {
    ingressArgs.timeoutMs = timeoutMs;
  }
  if (args.signal !== undefined) {
    ingressArgs.signal = args.signal;
  }
  if (args.now !== undefined) {
    ingressArgs.now = args.now;
  }
  if (args.probeTransport !== undefined) {
    ingressArgs.probeTransport = args.probeTransport;
  }

  const ingress = await runIngress(ingressArgs);
  if (!ingress.ok) {
    return fail(
      ingress.reasonCode,
      ingress.message,
      sanitizeDiagnostics(ingress.diagnostics),
    );
  }

  return { ok: true, result: ingress.result };
}

function readReactBundleExplicitCdnRequest(
  output: ProviderStructuredOutput,
):
  | { ok: true; value: ReactBundleExplicitCdnArtifactIngressRequest }
  | { ok: false; message: string } {
  if (
    output.schemaVersion !== 1 ||
    output.kind !== 'react_bundle_explicit_cdn_artifact'
  ) {
    return {
      ok: false,
      message:
        'structured_output_invalid: unsupported structured artifact intent',
    };
  }

  const payload = output.payload;
  if (!isStructuredOutputRecord(payload)) {
    return {
      ok: false,
      message:
        'structured_output_invalid: react bundle structured payload must be an object',
    };
  }

  try {
    return {
      ok: true,
      value: decodeReactBundleDependencyPrepareRequest(payload),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `structured_output_invalid: react bundle structured payload is invalid: ${message}`,
    };
  }
}

function sanitizeDiagnostics(
  diagnostics: Extract<
    ReactBundleExplicitCdnArtifactIngressResult,
    { ok: false }
  >['diagnostics'],
): FailureDiagnostics {
  if (!diagnostics) {
    return undefined;
  }

  const safe: NonNullable<FailureDiagnostics> = {};
  if (diagnostics.underlyingReasonCode !== undefined) {
    safe.underlyingReasonCode = diagnostics.underlyingReasonCode;
  }
  if (
    diagnostics.prepareEvidenceRef !== undefined &&
    isOpaqueSandboxOutputEvidenceRef(diagnostics.prepareEvidenceRef)
  ) {
    safe.prepareEvidenceRef = diagnostics.prepareEvidenceRef;
  }
  if (
    diagnostics.probeEvidenceRef !== undefined &&
    isOpaqueSandboxOutputEvidenceRef(diagnostics.probeEvidenceRef)
  ) {
    safe.probeEvidenceRef = diagnostics.probeEvidenceRef;
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}

function isStructuredOutputRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fail(
  reasonCode: ReactBundleStructuredOutputCallerFailureReason,
  message: string,
  diagnostics?: FailureDiagnostics,
): Extract<ReactBundleStructuredOutputCallerResult, { ok: false }> {
  return {
    ok: false,
    reasonCode,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
