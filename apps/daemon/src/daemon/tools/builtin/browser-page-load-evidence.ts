import { z } from 'zod';
import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_URL_BYTES,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
  type PtcBrowserPageLoadEvidenceRuntimeResult,
  type PtcBrowserPageLoadEvidenceRuntimeSummary,
} from '../../ptc/runtime/browser/browser-page-load-evidence-runtime-contract.js';
import { createRunWorkspaceContext } from '../../run-workspace-context.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  browserFailureReasonMessage,
  browserFailureReasonToToolErrorCode,
  pickBrowserPageLoadEvidencePolicyOutputFields,
  pickBrowserSafeDiagnosticFields,
} from './browser-summary-output.js';

const browserPageLoadEvidenceArgsSchema = z.strictObject({
  url: z
    .string()
    .min(1, 'url is required.')
    .max(PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_URL_BYTES)
    .describe(
      'Absolute public http or https URL to load in the PTC lab browser. Credentials, request bodies, screenshots, DOM extraction, and artifact export are not supported.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Page-load timeout in milliseconds. Must be at most ${PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS}.`,
    ),
});

type BrowserPageLoadEvidenceArgs = z.output<
  typeof browserPageLoadEvidenceArgsSchema
>;

export const browserPageLoadEvidenceTool = defineZodTool({
  name: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME,
  description:
    'Load one user-selected HTTP(S) URL inside the PTC lab browser and return compact page-load evidence: status, title, redirect count, timing, and digests only. Does not expose raw requested/final URLs, cookies, DOM, screenshots, or artifacts.',
  argsSchema: browserPageLoadEvidenceArgsSchema,
  sideEffectLevel: 'write',
  mayMutateWorkspaceFiles: false,
  requiresApproval: true,
  async executeParsed(args: BrowserPageLoadEvidenceArgs, ctx) {
    if (!ctx.threadId || !ctx.projectId) {
      return toolError(
        'execution_failed',
        'run context is required for browser_page_load_evidence.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.ptcBrowserPageLoadEvidence;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'PTC browser page-load evidence runtime is required.',
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
    const result = await runtime.collectEvidence(
      ctx.signal === undefined
        ? runtimeArgs
        : { ...runtimeArgs, signal: ctx.signal },
    );
    if (!result.ok) {
      const message = browserFailureReasonMessage({
        reasonCode: result.reasonCode,
        subject: 'page-load evidence',
      });
      return {
        ok: false,
        output: stringifyBrowserPageLoadEvidenceFailure(result),
        errorCode: browserFailureReasonToToolErrorCode(result.reasonCode),
        error: message,
      };
    }

    return {
      ok: true,
      output: stringifyBrowserPageLoadEvidenceSummary(result.value),
    };
  },
});

function stringifyBrowserPageLoadEvidenceSummary(
  summary: PtcBrowserPageLoadEvidenceRuntimeSummary,
): string {
  return JSON.stringify({
    kind: summary.kind,
    ok: summary.ok,
    profile: summary.profile,
    capability: summary.capability,
    targetDigest: summary.targetDigest,
    pageLoadEvidenceAttemptDigest: summary.pageLoadEvidenceAttemptDigest,
    pageLoadEvidenceDigest: summary.pageLoadEvidenceDigest,
    sessionLifecycle: summary.sessionLifecycle,
    ...pickBrowserPageLoadEvidencePolicyOutputFields(summary),
    requestedUrl: summary.requestedUrl,
    finalUrl: summary.finalUrl,
    loadOutcome: summary.loadOutcome,
    loadState: summary.loadState,
    responseStatus: summary.responseStatus,
    title: summary.title,
    redirects: summary.redirects,
    timing: summary.timing,
    evidenceAvailability: summary.evidenceAvailability,
    checks: summary.checks,
  });
}

function stringifyBrowserPageLoadEvidenceFailure(
  failure: Extract<PtcBrowserPageLoadEvidenceRuntimeResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: failure.kind,
    ok: failure.ok,
    reasonCode: failure.reasonCode,
    message: browserFailureReasonMessage({
      reasonCode: failure.reasonCode,
      subject: 'page-load evidence',
    }),
    phase: failure.phase,
    targetDigest: failure.targetDigest,
    pageLoadEvidenceAttemptDigest: failure.pageLoadEvidenceAttemptDigest,
    sessionLifecycle: failure.sessionLifecycle,
    diagnostics: pickBrowserSafeDiagnosticFields(failure.diagnostics),
  });
}
