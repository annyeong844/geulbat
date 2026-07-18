import { z } from 'zod';
import {
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS,
  PTC_BROWSER_NAVIGATE_MAX_URL_BYTES,
  PTC_BROWSER_NAVIGATE_TOOL_NAME,
  type PtcBrowserNavigateRuntimeResult,
  type PtcBrowserNavigateRuntimeSummary,
} from '../../ptc/runtime/browser/browser-navigate-runtime-contract.js';
import { createRunContext } from '../../run-context.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  browserFailureReasonMessage,
  browserFailureReasonToToolErrorCode,
  pickBrowserNavigatePolicyOutputFields,
  pickBrowserSafeDiagnosticFields,
} from './browser-summary-output.js';

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
  mayMutateComputerFiles: false,
  requiresApproval: true,
  catalogSearchMetadata: {
    family: 'browser',
    searchHints: ['browser navigate', 'open webpage in browser', 'visit url'],
    tags: ['browser', 'ptc', 'navigation'],
    whenToUse: 'Navigate a fresh PTC browser to one user-provided URL.',
    notFor: 'Query-based search, arbitrary browser sessions, or file URLs.',
  },
  async executeParsed(args: BrowserNavigateArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
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
      runContext: createRunContext({
        threadId: ctx.threadId,
        stateRoot: ctx.stateRoot,
        workingDirectory: ctx.workingDirectory ?? '',
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
      const message = browserFailureReasonMessage({
        reasonCode: result.reasonCode,
        subject: 'navigation',
      });
      return {
        ok: false,
        output: stringifyBrowserNavigateFailure(result),
        errorCode: browserFailureReasonToToolErrorCode(result.reasonCode),
        error: message,
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
    ...pickBrowserNavigatePolicyOutputFields(summary),
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
    message: browserFailureReasonMessage({
      reasonCode: failure.reasonCode,
      subject: 'navigation',
    }),
    phase: failure.phase,
    targetDigest: failure.targetDigest,
    navigationAttemptDigest: failure.navigationAttemptDigest,
    sessionLifecycle: failure.sessionLifecycle,
    diagnostics: pickBrowserSafeDiagnosticFields(failure.diagnostics),
  });
}
