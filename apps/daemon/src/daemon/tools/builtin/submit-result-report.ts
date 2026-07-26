import { z } from 'zod';

import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const submitResultReportArgsSchema = z.strictObject({
  summary: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Concise supplemental summary. The final prose remains the canonical result body.',
    ),
});

export const submitResultReportTool = defineZodTool({
  name: 'submit_result_report',
  description:
    'Attach an optional supplemental summary to this child result. Continue with the full final prose afterward; durable storage binds the summary to the exact original result ref and digest.',
  argsSchema: submitResultReportArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'agent',
    searchHints: ['child report', 'result summary', 'submit report'],
    tags: ['subagent', 'result', 'report'],
    whenToUse:
      'In a child run when a compact machine-readable handoff helps the parent interpret the full final prose.',
    notFor:
      'Replacing, truncating, or summarizing away the canonical final prose.',
  },
  async executeParsed(args, ctx) {
    if (
      ctx.kind !== 'agent' ||
      ctx.runOwnerKind !== 'child' ||
      ctx.runState === undefined ||
      ctx.runtimeServices?.subagent.terminalDeliveries === undefined
    ) {
      return toolError(
        'execution_failed',
        'submit_result_report requires an active child run with durable result storage.',
      );
    }
    ctx.runState.subagentResultReportSummary = args.summary;
    return {
      ok: true,
      output: JSON.stringify({
        ok: true,
        status: 'recorded',
      }),
    };
  },
});
