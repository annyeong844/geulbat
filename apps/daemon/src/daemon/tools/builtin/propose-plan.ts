import { z } from 'zod';

import { assertRunId } from '@geulbat/protocol/ids';
import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const planDraftStepSchema = z.strictObject({
  id: z.string().min(1, 'step id is required.'),
  text: z.string().min(1, 'step text is required.'),
  acceptanceCriteria: z.array(z.string()),
});

const planDraftDecisionSchema = z.strictObject({
  text: z.string().min(1, 'decision text is required.'),
  settledBy: z.enum(['user', 'agent']),
});

const proposePlanArgsSchema = z.strictObject({
  outcome: z.string().min(1, 'outcome is required.'),
  steps: z.array(planDraftStepSchema).min(1, 'at least one step is required.'),
  decisions: z.array(planDraftDecisionSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export const proposePlanTool = defineZodTool({
  name: 'propose_plan',
  description:
    'Submit the exact canonical plan draft for host approval. The daemon allocates the plan identity, revision, and digest, persists the draft, and returns its exact rendering stamp.',
  argsSchema: proposePlanArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'reconcile_then_replay',
  catalogSearchMetadata: {
    family: 'planning',
    searchHints: [
      'propose plan',
      'submit plan',
      'plan approval',
      'canonical plan',
    ],
    tags: ['plan', 'approval', 'draft'],
    whenToUse:
      'Finish a planning workflow by submitting the exact plan the user will approve.',
    notFor:
      'Publishing progress, changing files, or revising an already approved plan.',
  },
  async executeParsed(args, ctx) {
    if (
      ctx.kind !== 'agent' ||
      ctx.runtimeServices === undefined ||
      ctx.threadId === undefined ||
      ctx.runId === undefined
    ) {
      return toolError(
        'execution_failed',
        'agent planning workflow context is required for propose_plan.',
      );
    }
    const draft: PlanDraftV1 = {
      schemaVersion: 'plan_draft_v1',
      outcome: args.outcome,
      steps: args.steps,
      decisions: args.decisions,
      assumptions: args.assumptions,
      openQuestions: args.openQuestions,
    };
    try {
      const snapshot = await ctx.runtimeServices.planningWorkflows.propose({
        threadId: ctx.threadId,
        proposalRunId: assertRunId(ctx.runId),
        draft,
      });
      ctx.emitAgentEvent({
        type: 'planning_workflow_updated',
        payload: snapshot,
      });
      return {
        ok: true,
        output: JSON.stringify({
          proposed: true,
          workflowId: snapshot.workflowId,
          planId: snapshot.planId,
          revision: snapshot.revision,
          digest: snapshot.digest,
        }),
      };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
