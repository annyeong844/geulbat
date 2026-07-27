import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  loadPlanState,
  savePlanState,
  type PlanItem,
} from '../../plan-state-store.js';
import { defineZodTool } from '../zod-tool.js';

const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const planStepSchema = z
  .strictObject({
    id: z
      .string()
      .min(1, 'id is required when supplied.')
      .optional()
      .describe('Stable approved plan step identity when one exists.'),
    step: z.string().min(1, 'step is required.'),
    status: z
      .enum(PLAN_STATUSES)
      .describe('The current status for this plan step.'),
  })
  .describe('One user-visible plan step.');

const updatePlanArgsSchema = z.strictObject({
  explanation: z
    .string()
    .optional()
    .describe('Optional short note explaining why the plan changed.'),
  plan: z
    .array(planStepSchema)
    .describe('The complete current plan, in display order.'),
});

type UpdatePlanArgs = z.output<typeof updatePlanArgsSchema>;

export const updatePlanTool = defineZodTool({
  name: 'update_plan',
  description:
    'Replace the per-thread visible task plan with the supplied ordered plan steps and statuses.',
  argsSchema: updatePlanArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  abortSettlement: 'await_execution',
  recoveryStrategy: 'replay_safe',
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'planning',
    searchHints: ['update plan', 'plan steps', 'task list', 'todo'],
    tags: ['plan', 'task', 'thread'],
    whenToUse: 'Publish or revise the visible per-thread plan.',
    notFor: 'Changing code, applying repository patches, or running commands.',
  },
  async executeParsed(args, ctx) {
    const threadId = ctx.threadId;
    const stateRoot = ctx.stateRoot;
    if (!threadId || !stateRoot) {
      return toolError(
        'execution_failed',
        'thread and Home state context are required for update_plan.',
      );
    }

    try {
      const current = await loadPlanState(stateRoot, threadId);
      const state = {
        ...buildPlanState(args),
        ...(current.execution === undefined
          ? {}
          : { execution: current.execution }),
      };
      await savePlanState(stateRoot, threadId, state);
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          explanation: args.explanation ?? '',
          total: args.plan.length,
          plan: args.plan,
        }),
      };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});

function buildPlanState(args: UpdatePlanArgs): {
  nextId: number;
  items: PlanItem[];
} {
  const createdAt = Date.now();
  const items = args.plan.map((item, index) => ({
    id: item.id ?? String(index + 1),
    text: item.step,
    status: item.status,
    createdAt,
  }));
  return {
    nextId: items.length + 1,
    items,
  };
}
