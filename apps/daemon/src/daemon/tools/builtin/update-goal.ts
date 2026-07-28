import { z } from 'zod';
import { assertRunId } from '@geulbat/protocol/ids';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const updateGoalArgsSchema = z.strictObject({
  status: z
    .literal('complete')
    .describe(
      'Request host completion admission after concrete execution evidence shows the Goal is achieved.',
    ),
});

export const updateGoalTool = defineZodTool({
  name: 'update_goal',
  description:
    'Request completion of the active Goal. This ends the current tool round so the host can check deterministic completion obligations before admitting completion.',
  argsSchema: updateGoalArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'reconcile_then_replay',
  endsTurnAfterSuccess: true,
  catalogSearchMetadata: {
    family: 'planning',
    searchHints: ['goal complete', 'finish goal', 'admit completion'],
    tags: ['goal', 'completion'],
    whenToUse:
      'Only in an explicit Goal run, after concrete execution evidence shows the objective is complete.',
    notFor:
      'Ordinary chat, reporting progress, or claiming completion without execution evidence.',
  },
  async executeParsed(_args, ctx) {
    if (ctx.kind !== 'agent' || ctx.runtimeServices === undefined) {
      return toolError(
        'execution_failed',
        'an active agent Goal context is required for update_goal.',
      );
    }
    try {
      const goal = await ctx.runtimeServices.goals.readForRun({
        threadId: ctx.threadId,
      });
      if (goal === null) {
        return toolError(
          'execution_failed',
          'no active Goal is available for completion admission.',
        );
      }
      const snapshot = await ctx.runtimeServices.goals.requestCompletion({
        threadId: ctx.threadId,
        goalId: goal.goalId,
        runId: assertRunId(ctx.runId),
      });
      ctx.emitAgentEvent({
        type: 'goal_updated',
        payload: snapshot,
      });
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          status: 'completion_requested',
        }),
      };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
