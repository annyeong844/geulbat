import { z } from 'zod';
import {
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
  PTC_BROWSER_NAVIGATE_MAX_URL_BYTES,
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
  PTC_BROWSER_NAVIGATE_TOOL_TIMEOUT_MS,
  type PtcBrowserNavigateFailureReason,
  type PtcBrowserNavigateRuntimeError,
  type PtcBrowserNavigateRuntimeResult,
  type PtcBrowserNavigateRuntimeSummary,
} from '../../daemon-runtime-contract.js';
import { createRunWorkspaceContext } from '../../run-workspace-context.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const browserNavigateArgsSchema = z.strictObject({
  url: z
    .string()
    .min(1, 'url is required.')
    .max(PTC_BROWSER_NAVIGATE_MAX_URL_BYTES)
    .describe(
      'Absolute public http or https URL to navigate in the PTC lab browser. Credentials, request bodies, screenshots, DOM extraction, and artifact export are not supported in this slice.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Navigation timeout in milliseconds. Must be at most ${PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS}.`,
    ),
});

type BrowserNavigateArgs = z.output<typeof browserNavigateArgsSchema>;

export const browserNavigateTool = defineZodTool({
  name: PTC_BROWSER_NAVIGATE_TOOL_NAME,
  description:
    'Navigate one user-selected HTTP(S) URL inside the PTC lab browser and return a digest-only navigation summary. Does not expose raw requested/final URLs, cookies, DOM, screenshots, or artifacts.',
  argsSchema: browserNavigateArgsSchema,
  sideEffectLevel: 'write',
  mayMutateWorkspaceFiles: false,
  timeoutMs: PTC_BROWSER_NAVIGATE_TOOL_TIMEOUT_MS,
  requiresApproval: true,
  async executeParsed(args: BrowserNavigateArgs, ctx) {
    if (!ctx.threadId || !ctx.projectId) {
      return toolError(
        'execution_failed',
        'run context is required for browser_navigate.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.ptcBrowserNavigate;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'PTC browser navigation runtime is required.',
      );
    }

    const runtimeArgs = {
      runContext: createRunWorkspaceContext({
        threadId: ctx.threadId,
        projectId: ctx.projectId,
        workspaceRoot: ctx.workspaceRoot,
      }),
      request: {
        url: args.url,
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
    };
    const result = await runtime.navigate(
      ctx.signal === undefined
        ? runtimeArgs
        : { ...runtimeArgs, signal: ctx.signal },
    );
    if (!result.ok) {
      return {
        ok: false,
        output: stringifyBrowserNavigateFailure(result),
        errorCode: browserNavigateFailureToToolErrorCode(result.reasonCode),
        error: result.message,
      };
    }

    return {
      ok: true,
      output: stringifyBrowserNavigateSummary(result.value),
    };
  },
});

function stringifyBrowserNavigateSummary(
  summary: PtcBrowserNavigateRuntimeSummary,
): string {
  return JSON.stringify({
    kind: summary.kind,
    ok: summary.ok,
    profile: summary.profile,
    capability: summary.capability,
    targetDigest: summary.targetDigest,
    navigationAttemptDigest: summary.navigationAttemptDigest,
    sessionLifecycle: summary.sessionLifecycle,
    browserPolicyId: summary.browserPolicyId,
    browserMode: summary.browserMode,
    browserEnginePolicyId: summary.browserEnginePolicyId,
    browserNetworkPolicyId: summary.browserNetworkPolicyId,
    browserUrlGrammarPolicyId: summary.browserUrlGrammarPolicyId,
    browserRedirectPolicyId: summary.browserRedirectPolicyId,
    browserEvidencePolicyId: summary.browserEvidencePolicyId,
    browserUrlEchoPolicyId: summary.browserUrlEchoPolicyId,
    browserPopupPolicyId: summary.browserPopupPolicyId,
    browserPermissionPolicyId: summary.browserPermissionPolicyId,
    browserProfilePolicyId: summary.browserProfilePolicyId,
    browserCookieStorePolicyId: summary.browserCookieStorePolicyId,
    browserDownloadPolicyId: summary.browserDownloadPolicyId,
    browserArtifactExportPolicyId: summary.browserArtifactExportPolicyId,
    artifactExported: summary.artifactExported,
    requestedUrlRedacted: summary.requestedUrlRedacted,
    finalUrlRedacted: summary.finalUrlRedacted,
    navigationOutcome: summary.navigationOutcome,
    loadState: summary.loadState,
    checks: summary.checks,
    durationMs: summary.durationMs,
  });
}

function stringifyBrowserNavigateFailure(
  failure: Extract<PtcBrowserNavigateRuntimeResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: failure.kind,
    ok: failure.ok,
    reasonCode: failure.reasonCode,
    message: failure.message,
    phase: failure.phase,
    targetDigest: failure.targetDigest,
    navigationAttemptDigest: failure.navigationAttemptDigest,
    sessionLifecycle: failure.sessionLifecycle,
    diagnostics: sanitizeBrowserNavigateDiagnostics(failure.diagnostics),
  });
}

function sanitizeBrowserNavigateDiagnostics(
  diagnostics: PtcBrowserNavigateRuntimeError['diagnostics'],
): PtcBrowserNavigateRuntimeError['diagnostics'] {
  if (diagnostics === undefined) {
    return undefined;
  }
  const safe: Record<string, string | number | boolean> = {};
  for (const key of [
    'admissionReasonCode',
    'unsupportedCategory',
    'maxUrlBytes',
    'sessionReasonCode',
    'sessionTainted',
    'sessionCloseFailed',
    'commandResultKind',
    'inputCleanupFailed',
    'workspaceRootRealpathFailed',
  ]) {
    const value = diagnostics[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function browserNavigateFailureToToolErrorCode(
  reasonCode: PtcBrowserNavigateFailureReason,
): ErrorCode {
  switch (reasonCode) {
    case 'ptc_lab_browser_policy_disabled':
    case 'ptc_lab_browser_policy_mismatch':
    case 'ptc_lab_browser_network_disabled':
    case 'ptc_lab_browser_request_invalid':
    case 'ptc_lab_browser_url_admission_failed':
    case 'ptc_lab_browser_target_digest_mismatch':
      return 'invalid_args';
    case 'ptc_lab_browser_timeout':
      return 'timeout';
    case 'ptc_lab_browser_cancelled':
      return 'aborted';
    case 'ptc_lab_browser_session_unavailable':
    case 'ptc_lab_browser_runtime_unavailable':
    case 'ptc_lab_browser_navigation_failed':
    case 'ptc_lab_browser_redirect_disallowed':
    case 'ptc_lab_browser_download_disallowed':
    case 'ptc_lab_browser_popup_disallowed':
    case 'ptc_lab_browser_output_invalid':
    case 'ptc_lab_browser_session_tainted':
    case 'ptc_lab_browser_cleanup_failed':
    case 'ptc_lab_browser_cleanup_uncertain':
      return 'execution_failed';
  }
}
