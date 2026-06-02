import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import type { SandboxAttemptStore } from '../sandbox/attempt-store.js';
import {
  runReactBundleExplicitCdnArtifactIngress,
  type ReactBundleExplicitCdnArtifactIngressFailureReason,
  type ReactBundleExplicitCdnArtifactIngressRequest,
  type ReactBundleExplicitCdnArtifactIngressResult,
} from './react-bundle-explicit-cdn-artifact-ingress.js';
import type { AgentResult } from './agent-result.js';

export type ReactBundleStructuredOutputCallerFailureReason =
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
  timeoutMs: number;
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
    timeoutMs: args.timeoutMs,
  };
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

  const payload = asRecord(output.payload);
  if (!payload) {
    return {
      ok: false,
      message:
        'structured_output_invalid: react bundle structured payload must be an object',
    };
  }

  if (typeof payload.entryUrl !== 'string') {
    return {
      ok: false,
      message:
        'structured_output_invalid: react bundle structured payload requires entryUrl',
    };
  }

  const runtimeDependencies = asRecord(payload.runtimeDependencies);
  if (!runtimeDependencies) {
    return {
      ok: false,
      message:
        'structured_output_invalid: react bundle structured payload requires runtimeDependencies object',
    };
  }

  if (!Array.isArray(payload.dependencyRefs)) {
    return {
      ok: false,
      message:
        'structured_output_invalid: react bundle structured payload requires dependencyRefs array',
    };
  }

  return {
    ok: true,
    value: {
      entryUrl: payload.entryUrl,
      runtimeDependencies:
        runtimeDependencies as ReactBundleExplicitCdnArtifactIngressRequest['runtimeDependencies'],
      dependencyRefs:
        payload.dependencyRefs as ReactBundleExplicitCdnArtifactIngressRequest['dependencyRefs'],
    },
  };
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
    isOpaqueEvidenceRef(diagnostics.prepareEvidenceRef)
  ) {
    safe.prepareEvidenceRef = diagnostics.prepareEvidenceRef;
  }
  if (
    diagnostics.probeEvidenceRef !== undefined &&
    isOpaqueEvidenceRef(diagnostics.probeEvidenceRef)
  ) {
    safe.probeEvidenceRef = diagnostics.probeEvidenceRef;
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}

function isOpaqueEvidenceRef(value: string): boolean {
  const prefix = 'sandbox-output:';
  if (!value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  if (suffix.length === 0) return false;
  if (/[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  return (
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('.geulbat') &&
    !value.includes('..') &&
    !value.startsWith('file:')
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
