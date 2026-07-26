import { z } from 'zod';
import { assertRunId } from '@geulbat/protocol/ids';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const updateGoalArgsSchema = z.strictObject({
  status: z
    .literal('complete')
    .describe(
      'Request independent completion verification after the Goal is actually achieved.',
    ),
});

export const updateGoalTool = defineZodTool({
  name: 'update_goal',
  description:
    'Request completion of the active Goal. This ends the current tool round and starts the hidden independent completion verification panel; it does not complete the Goal by itself.',
  argsSchema: updateGoalArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  endsTurnAfterSuccess: true,
  catalogSearchMetadata: {
    family: 'planning',
    searchHints: ['goal complete', 'finish goal', 'verify completion'],
    tags: ['goal', 'completion', 'verification'],
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
          'no active Goal is available for completion verification.',
        );
      }
      const snapshot = await ctx.runtimeServices.goals.requestVerification({
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
          status: 'verifying',
        }),
      };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});
