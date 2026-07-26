import {
  SUBAGENT_LAUNCH_PRIORITY_CLASSES,
  isSubagentLaunchPriorityClass,
  type SubagentLaunchPriorityClass,
} from '@geulbat/protocol/run-events';
import { isRunId, type RunId } from '@geulbat/protocol/ids';

import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { toolError } from '../result.js';
import type { AgentRuntimeSubagentServices } from '../../daemon-runtime-contract.js';

// Queue reprioritization only touches the durable launch-request store.
type AgentSetPriorityServices = {
  subagent: Pick<AgentRuntimeSubagentServices, 'launchRequests'>;
};

interface AgentSetPriorityArgs {
  child_run_id: RunId;
  priority: SubagentLaunchPriorityClass;
}

const agentSetPriorityParameters = {
  type: 'object' as const,
  properties: {
    child_run_id: {
      type: 'string',
      description: 'Stable child handle returned by agent_spawn.',
    },
    priority: {
      type: 'string',
      description:
        'Semantic priority for a durably queued launch. It does not change the launch order within the same priority class.',
      enum: [...SUBAGENT_LAUNCH_PRIORITY_CLASSES],
    },
  },
  required: ['child_run_id', 'priority'],
  additionalProperties: false as const,
};

function parseAgentSetPriorityArgs(raw: unknown) {
  const parsed = readToolArgsRecord(raw, ['child_run_id', 'priority']);
  if (!parsed.ok) {
    return parsed;
  }
  const childRunId = parsed.value.child_run_id;
  if (typeof childRunId !== 'string') {
    return failToolParse('child_run_id must be a valid run id.');
  }
  const normalizedChildRunId = childRunId.trim();
  if (!isRunId(normalizedChildRunId)) {
    return failToolParse('child_run_id must be a valid run id.');
  }
  if (!isSubagentLaunchPriorityClass(parsed.value.priority)) {
    return failToolParse(
      `priority must be one of: ${SUBAGENT_LAUNCH_PRIORITY_CLASSES.join(', ')}.`,
    );
  }
  return {
    ok: true as const,
    value: {
      child_run_id: normalizedChildRunId,
      priority: parsed.value.priority,
    },
  };
}

export const agentSetPriorityTool = defineParsedTool<AgentSetPriorityArgs>({
  name: 'agent_set_priority',
  description:
    'Change the semantic priority of a durably queued child launch without changing its same-class enqueue order.',
  parameters: agentSetPriorityParameters,
  strict: true,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'agent',
    searchHints: [
      'change agent priority',
      'prioritize subagent',
      'deprioritize queued agent',
    ],
    tags: ['agent', 'subagent', 'priority', 'queue'],
    whenToUse: 'Change priority for an accepted child that is still queued.',
    notFor: 'Reordering active or terminal child runs.',
  },
  parseArgs: parseAgentSetPriorityArgs,
  async executeParsed(args, ctx) {
    if (!ctx.threadId || !ctx.runtimeServices) {
      return toolError(
        'execution_failed',
        'agent_set_priority requires agent runtime and thread context',
      );
    }
    const services: AgentSetPriorityServices = ctx.runtimeServices;
    const launchRequestStore = services.subagent.launchRequests;
    if (launchRequestStore === undefined) {
      return toolError(
        'persistence_unavailable',
        'durable agent launch state is unavailable',
      );
    }

    let current;
    try {
      current = launchRequestStore.readSubagentLaunchRequestByChildRunId(
        args.child_run_id,
      );
    } catch {
      return toolError(
        'persistence_unavailable',
        'agent launch status could not be read',
      );
    }
    if (current === undefined) {
      return toolError(
        'invalid_args',
        `unknown child run: ${args.child_run_id}`,
      );
    }
    if (current.ownerThreadId !== ctx.threadId) {
      return toolError(
        'invalid_args',
        `child run does not belong to current owner thread: ${args.child_run_id}`,
      );
    }
    if (current.launchState !== 'queued') {
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          childRunId: current.childRunId,
          launchState: current.launchState,
          priorityClass: current.priorityClass,
          updateState: 'not_queued',
        }),
      };
    }

    let updated;
    try {
      updated = launchRequestStore.updateQueuedSubagentLaunchPriority({
        childRunId: args.child_run_id,
        ownerThreadId: ctx.threadId,
        priorityClass: args.priority,
      });
    } catch {
      return toolError(
        'persistence_unavailable',
        'queued agent launch priority could not be updated',
      );
    }
    return {
      ok: true,
      output: JSON.stringify({
        ok: true,
        childRunId: updated.childRunId,
        launchState: updated.launchState,
        priorityClass: updated.priorityClass,
        updateState:
          updated.launchState !== 'queued'
            ? 'not_queued'
            : current.priorityClass === updated.priorityClass
              ? 'unchanged'
              : 'updated',
      }),
    };
  },
});
