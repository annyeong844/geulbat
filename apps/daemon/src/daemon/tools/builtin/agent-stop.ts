import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import { toolError } from '../result.js';
import { isAgentChildTerminalState } from '../../subagent-runtime-contracts.js';
import type {
  AgentRuntimeServices,
  AgentRuntimeSubagentServices,
} from '../../daemon-runtime-contract.js';

// Stopping a child touches run abort, the child registry, and the durable
// subagent launch/terminal stores — declare exactly that surface.
type AgentStopServices = {
  activeRuns: AgentRuntimeServices['activeRuns'];
  childRuns: AgentRuntimeServices['childRuns'];
  subagent: Pick<
    AgentRuntimeSubagentServices,
    'launchPromotions' | 'launchRequests' | 'terminalDeliveries'
  >;
};

interface AgentStopArgs {
  child_run_id: RunId;
}

interface AgentStopResult {
  ok: true;
  childRunId: RunId;
  stopState: 'stopping' | 'already_terminal' | 'cancelled_before_start';
}

const agentStopParameters = {
  type: 'object' as const,
  properties: {
    child_run_id: {
      type: 'string',
      description: 'Stable child handle returned by agent_spawn.',
    },
  },
  required: ['child_run_id'],
  additionalProperties: false as const,
};

function parseAgentStopArgs(raw: unknown) {
  const parsed = readToolArgsRecord(raw, ['child_run_id']);
  if (!parsed.ok) {
    return parsed;
  }

  const childRunId = parsed.value.child_run_id;
  if (typeof childRunId !== 'string' || childRunId.trim().length === 0) {
    return failToolParse('child_run_id is required.');
  }
  const normalizedChildRunId = childRunId.trim();
  if (!isRunId(normalizedChildRunId)) {
    return failToolParse('child_run_id must be a valid run id.');
  }

  return {
    ok: true as const,
    value: {
      child_run_id: normalizedChildRunId,
    },
  };
}

function buildStopResult(result: AgentStopResult) {
  return {
    ok: true as const,
    output: JSON.stringify(result),
  };
}

export const agentStopTool = defineParsedTool<AgentStopArgs>({
  name: 'agent_stop',
  description:
    'Cancel a durably queued child before start or request cancellation for a running child handle. Terminal children are returned as already_terminal.',
  parameters: agentStopParameters,
  strict: true,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'agent',
    searchHints: ['stop agent', 'cancel subagent', 'terminate agent'],
    tags: ['agent', 'subagent', 'cancel'],
    whenToUse: 'Cancel a queued or active subagent handle.',
    notFor: 'Waiting for a subagent to finish normally.',
  },
  parseArgs: parseAgentStopArgs,
  async executeParsed(args, ctx) {
    if (!ctx.threadId || !ctx.runId || !ctx.runtimeServices) {
      return toolError('execution_failed', 'agent_stop requires agent runtime');
    }
    const services: AgentStopServices = ctx.runtimeServices;

    const childRecord = services.childRuns.getChildRun(args.child_run_id);
    if (!childRecord) {
      const launchRequestStore = services.subagent.launchRequests;
      if (launchRequestStore === undefined) {
        return toolError(
          'invalid_args',
          `unknown child run: ${args.child_run_id}`,
        );
      }
      let durableRequest;
      try {
        durableRequest =
          launchRequestStore.readSubagentLaunchRequestByChildRunId(
            args.child_run_id,
          );
      } catch {
        return toolError(
          'persistence_unavailable',
          'agent launch status could not be read',
        );
      }
      if (durableRequest === undefined) {
        return toolError(
          'invalid_args',
          `unknown child run: ${args.child_run_id}`,
        );
      }
      if (durableRequest.ownerThreadId !== ctx.threadId) {
        return toolError(
          'invalid_args',
          `child run does not belong to current owner thread: ${args.child_run_id}`,
        );
      }
      if (durableRequest.launchState === 'queued') {
        try {
          durableRequest = launchRequestStore.cancelQueuedSubagentLaunchRequest(
            {
              childRunId: args.child_run_id,
              ownerThreadId: ctx.threadId,
            },
          );
        } catch {
          return toolError(
            'persistence_unavailable',
            'queued agent launch could not be cancelled',
          );
        }
        if (durableRequest.launchState === 'cancelled') {
          services.subagent.launchPromotions?.forgetLaunch(args.child_run_id);
          return buildStopResult({
            ok: true,
            childRunId: args.child_run_id,
            stopState: 'cancelled_before_start',
          });
        }
      }
      if (
        durableRequest.launchState === 'cancelled' ||
        durableRequest.launchState === 'failed_to_start'
      ) {
        return buildStopResult({
          ok: true,
          childRunId: args.child_run_id,
          stopState: 'already_terminal',
        });
      }
      if (
        services.activeRuns.abortRunSubtree(args.child_run_id, 'explicit_stop')
      ) {
        return buildStopResult({
          ok: true,
          childRunId: args.child_run_id,
          stopState: 'stopping',
        });
      }
      if (durableRequest.launchState === 'started') {
        const terminalDeliveryStore = services.subagent.terminalDeliveries;
        if (terminalDeliveryStore !== undefined) {
          let durableTerminal;
          try {
            durableTerminal =
              terminalDeliveryStore.readSubagentTerminalOutcomeByChildRunId(
                args.child_run_id,
              );
          } catch {
            return toolError(
              'persistence_unavailable',
              'agent terminal result could not be read',
            );
          }
          if (durableTerminal !== undefined) {
            if (durableTerminal.ownerThreadId !== ctx.threadId) {
              return toolError(
                'invalid_args',
                `child run does not belong to current owner thread: ${args.child_run_id}`,
              );
            }
            return buildStopResult({
              ok: true,
              childRunId: args.child_run_id,
              stopState: 'already_terminal',
            });
          }
        }
        return toolError(
          'execution_failed',
          `child launch is durably started but its active runtime handle is unavailable: ${args.child_run_id}`,
        );
      }
      return toolError(
        'execution_failed',
        `child launch is ${durableRequest.launchState}; retry cancellation after the start transition settles: ${args.child_run_id}`,
      );
    }
    if (childRecord.ownerThreadId !== ctx.threadId) {
      return toolError(
        'invalid_args',
        `child run does not belong to current owner thread: ${args.child_run_id}`,
      );
    }
    if (isAgentChildTerminalState(childRecord.status)) {
      return buildStopResult({
        ok: true,
        childRunId: args.child_run_id,
        stopState: 'already_terminal',
      });
    }

    if (
      !services.activeRuns.abortRunSubtree(args.child_run_id, 'explicit_stop')
    ) {
      return toolError(
        'execution_failed',
        `active child run missing: ${args.child_run_id}`,
      );
    }

    return buildStopResult({
      ok: true,
      childRunId: args.child_run_id,
      stopState: 'stopping',
    });
  },
});
