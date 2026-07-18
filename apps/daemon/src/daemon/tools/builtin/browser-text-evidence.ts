import { z } from 'zod';
import {
  PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS,
  PTC_BROWSER_TEXT_EVIDENCE_MAX_URL_BYTES,
  PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
  type PtcBrowserTextEvidenceRuntimeSummary,
} from '../../ptc/runtime/browser/browser-text-evidence-runtime-contract.js';
import { createRunContext } from '../../run-context.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import {
  browserFailureReasonMessage,
  browserFailureReasonToToolErrorCode,
  pickBrowserTextEvidencePolicyOutputFields,
  stringifyBrowserEvidenceFailureOutput,
} from './browser-summary-output.js';

const browserTextEvidenceArgsSchema = z.strictObject({
  url: z
    .string()
    .min(1, 'url is required.')
    .max(PTC_BROWSER_TEXT_EVIDENCE_MAX_URL_BYTES)
    .describe(
      'Absolute public http or https URL to load in the PTC lab browser. Credentials, request bodies, screenshots, HTML/DOM dumps, selectors, and artifact export are not supported.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Text evidence navigation timeout in milliseconds. Must be at most ${PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS}.`,
    ),
});

type BrowserTextEvidenceArgs = z.output<typeof browserTextEvidenceArgsSchema>;

export const browserTextEvidenceTool = defineZodTool({
  name: PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME,
  description:
    'Load one user-selected HTTP(S) URL inside the PTC lab browser and return visible text evidence plus redirect count, timing, and digests. Does not expose raw requested/final URLs, cookies, HTML/DOM dumps, screenshots, or artifacts.',
  argsSchema: browserTextEvidenceArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: true,
  catalogSearchMetadata: {
    family: 'browser',
    searchHints: ['text evidence', 'extract page text', 'browser text'],
    tags: ['browser', 'ptc', 'text'],
    whenToUse: 'Capture bounded visible text evidence for one explicit URL.',
    notFor: 'Interactive browser control or query-based web search.',
  },
  async executeParsed(args: BrowserTextEvidenceArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'execution_failed',
        'run context is required for browser_text_evidence.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.ptcBrowserTextEvidence;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'PTC browser text evidence runtime is required.',
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
    const result = await runtime.collectEvidence(
      ctx.signal === undefined
        ? runtimeArgs
        : { ...runtimeArgs, signal: ctx.signal },
    );
    if (!result.ok) {
      const message = browserFailureReasonMessage({
        reasonCode: result.reasonCode,
        subject: 'text evidence',
      });
      return {
        ok: false,
        output: stringifyBrowserEvidenceFailureOutput({
          failure: result,
          subject: 'text evidence',
          attemptDigestField: 'textEvidenceAttemptDigest',
        }),
        errorCode: browserFailureReasonToToolErrorCode(result.reasonCode),
        error: message,
      };
    }

    return {
      ok: true,
      output: stringifyBrowserTextEvidenceSummary(result.value),
    };
  },
});

function stringifyBrowserTextEvidenceSummary(
  summary: PtcBrowserTextEvidenceRuntimeSummary,
): string {
  return JSON.stringify({
    kind: summary.kind,
    ok: summary.ok,
    profile: summary.profile,
    capability: summary.capability,
    targetDigest: summary.targetDigest,
    textEvidenceAttemptDigest: summary.textEvidenceAttemptDigest,
    textEvidenceDigest: summary.textEvidenceDigest,
    sessionLifecycle: summary.sessionLifecycle,
    ...pickBrowserTextEvidencePolicyOutputFields(summary),
    requestedUrl: summary.requestedUrl,
    finalUrl: summary.finalUrl,
    loadOutcome: summary.loadOutcome,
    loadState: summary.loadState,
    visibleText: summary.visibleText,
    redirects: summary.redirects,
    timing: summary.timing,
    evidenceAvailability: summary.evidenceAvailability,
    checks: summary.checks,
  });
}
