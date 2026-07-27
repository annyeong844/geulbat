import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import { toolError } from '../result.js';
import type { AgentWaitMode } from '../agent-child-wait.js';
import { AGENT_WAIT_MODES, waitForAgentChildren } from '../agent-child-wait.js';
import type {
  DurableSubagentLaunchRequest,
  DurableSubagentTerminalOutcome,
} from '../../subagent-runtime-contracts.js';
import type {
  AgentRuntimeServices,
  AgentRuntimeSubagentServices,
} from '../../daemon-runtime-contract.js';

// Waiting on children needs the child registry plus the durable subagent
// launch/terminal stores — nothing else from the runtime bag.
type AgentWaitServices = {
  childRuns: AgentRuntimeServices['childRuns'];
  subagent: Pick<
    AgentRuntimeSubagentServices,
    'launchRequests' | 'terminalDeliveries'
  >;
};

interface AgentWaitArgs {
  child_run_ids: RunId[];
  wait_mode?: AgentWaitMode;
  result_mode?: AgentWaitResultMode;
}

const AGENT_WAIT_RESULT_MODES = ['inline', 'refs'] as const;
type AgentWaitResultMode = (typeof AGENT_WAIT_RESULT_MODES)[number];

const agentWaitParameters = {
  type: 'object' as const,
  properties: {
    child_run_ids: {
      type: 'array',
      description:
        'Child run handles returned by agent_spawn. Use one or more childRunId values.',
      items: {
        type: 'string',
      },
      minItems: 1,
    },
    wait_mode: {
      type: 'string',
      description:
        'snapshot returns the current durable launch, completed, pending, and blocked state immediately and is the default. all waits for every started child to become terminal. any returns after the first started child becomes terminal.',
      enum: [...AGENT_WAIT_MODES],
    },
    result_mode: {
      type: 'string',
      description:
        'inline returns exact child result bodies. refs returns durable resultRef values plus digest and terminal provenance without copying available SQLite-backed bodies into the coordinator context. Omitted mode defaults to inline for one child and refs for multiple children.',
      enum: [...AGENT_WAIT_RESULT_MODES],
    },
  },
  required: ['child_run_ids'],
  additionalProperties: false as const,
};

function parseAgentWaitArgs(raw: unknown) {
  const parsed = readToolArgsRecord(raw, [
    'child_run_ids',
    'wait_mode',
    'result_mode',
  ]);
  if (!parsed.ok) {
    return parsed;
  }

  const childRunIds = parsed.value.child_run_ids;
  if (
    !Array.isArray(childRunIds) ||
    childRunIds.length === 0 ||
    !childRunIds.every(
      (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
  ) {
    return failToolParse('child_run_ids must be a non-empty string array.');
  }

  const normalizedChildRunIds = childRunIds.map((value) => value.trim());
  if (!normalizedChildRunIds.every(isRunId)) {
    return failToolParse('child_run_ids must contain valid run ids.');
  }

  const waitMode = parsed.value.wait_mode;
  const normalizedWaitMode = AGENT_WAIT_MODES.find(
    (candidate) => candidate === waitMode,
  );
  if (waitMode !== undefined && normalizedWaitMode === undefined) {
    return failToolParse(
      `wait_mode must be one of: ${AGENT_WAIT_MODES.join(', ')}.`,
    );
  }
  const resultMode = AGENT_WAIT_RESULT_MODES.find(
    (candidate) => candidate === parsed.value.result_mode,
  );
  if (parsed.value.result_mode !== undefined && resultMode === undefined) {
    return failToolParse(
      `result_mode must be one of: ${AGENT_WAIT_RESULT_MODES.join(', ')}.`,
    );
  }

  return {
    ok: true as const,
    value: {
      child_run_ids: normalizedChildRunIds,
      ...(normalizedWaitMode !== undefined
        ? { wait_mode: normalizedWaitMode }
        : {}),
      ...(resultMode === undefined ? {} : { result_mode: resultMode }),
    },
  };
}

function createAgentWaitTool(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs;

  return defineParsedTool<AgentWaitArgs>({
    name: 'agent_wait',
    description:
      'Inspect durable launch and runtime status for child handles immediately, or explicitly join already-started children at a dependency barrier.',
    parameters: agentWaitParameters,
    strict: true,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    abortSettlement: 'await_execution',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    recoveryStrategy: 'replay_safe',
    resultProjection: {
      exactDurableRecovery: true,
      modelProjection: 'runtime_summary',
      snapshotFailure: 'inline',
    },
    catalogSearchMetadata: {
      family: 'agent',
      searchHints: ['wait for agent', 'join subagents', 'collect agent result'],
      tags: ['agent', 'subagent', 'wait'],
      whenToUse:
        'Check subagent progress without blocking, or explicitly join subagents when their results are required.',
      notFor: 'Launching new work or sending new input.',
    },
    parseArgs: parseAgentWaitArgs,
    async executeParsed(args, ctx) {
      if (!ctx.threadId || !ctx.runtimeServices) {
        return toolError(
          'execution_failed',
          'agent_wait requires agent runtime and thread context',
        );
      }

      const ownerThreadId = ctx.threadId;
      const waitMode = args.wait_mode ?? 'snapshot';
      const childRunIds = [...new Set(args.child_run_ids)];
      const resultMode =
        args.result_mode ?? (childRunIds.length > 1 ? 'refs' : 'inline');
      const services: AgentWaitServices = ctx.runtimeServices;
      const registry = services.childRuns;
      const launchRequestStore = services.subagent.launchRequests;
      const terminalDeliveryStore = services.subagent.terminalDeliveries;
      const interjectBuffer = ctx.interjectBuffer;
      const waitForChildren = (
        requestedChildRunIds: readonly RunId[],
        requestedWaitMode: AgentWaitMode,
        signal?: AbortSignal,
      ) =>
        waitForAgentChildren({
          registry,
          ownerThreadId,
          childRunIds: requestedChildRunIds,
          waitMode: requestedWaitMode,
          blockedBehavior: 'wait',
          ...(signal !== undefined ? { signal } : {}),
        });
      type AgentWaitOutcome =
        | Awaited<ReturnType<typeof waitForAgentChildren>>
        | {
            ok: false;
            errorCode: 'persistence_unavailable';
            message: string;
          };
      let outcome: AgentWaitOutcome;
      let durableLaunches: DurableSubagentLaunchRequest[] = [];
      let durableTerminalOutcomes: DurableSubagentTerminalOutcome[] = [];
      let durableTerminalChildRunIds = new Set<RunId>();
      const refreshDurableTerminalOutcomes = ():
        | { ok: true }
        | {
            ok: false;
            errorCode: 'invalid_args' | 'persistence_unavailable';
            message: string;
          } => {
        if (terminalDeliveryStore === undefined) {
          durableTerminalOutcomes = [];
          durableTerminalChildRunIds = new Set();
          return { ok: true };
        }
        try {
          durableTerminalOutcomes = childRunIds.flatMap((childRunId) => {
            const terminal =
              terminalDeliveryStore.readSubagentTerminalOutcomeByChildRunId(
                childRunId,
              );
            return terminal === undefined ? [] : [terminal];
          });
        } catch {
          return {
            ok: false,
            errorCode: 'persistence_unavailable',
            message: 'agent terminal result could not be read',
          };
        }
        const foreignTerminal = durableTerminalOutcomes.find(
          (terminal) => terminal.ownerThreadId !== ownerThreadId,
        );
        if (foreignTerminal !== undefined) {
          return {
            ok: false,
            errorCode: 'invalid_args',
            message: `child run does not belong to current owner thread: ${foreignTerminal.result.childRunId}`,
          };
        }
        durableTerminalChildRunIds = new Set(
          durableTerminalOutcomes.map((terminal) => terminal.result.childRunId),
        );
        return { ok: true };
      };
      const initialTerminalRead = refreshDurableTerminalOutcomes();
      if (!initialTerminalRead.ok) {
        return toolError(
          initialTerminalRead.errorCode,
          initialTerminalRead.message,
        );
      }
      const waitForChildrenWithDurableRecovery = async (
        requestedChildRunIds: readonly RunId[],
        requestedWaitMode: AgentWaitMode,
        signal?: AbortSignal,
      ): Promise<AgentWaitOutcome> => {
        while (true) {
          if (
            requestedWaitMode === 'any' &&
            requestedChildRunIds.some((childRunId) =>
              durableTerminalChildRunIds.has(childRunId),
            )
          ) {
            return {
              ok: true,
              result: {
                ok: true,
                completed: [],
                pending: [],
                blocked: [],
              },
            };
          }
          const runtimeChildRunIds = requestedChildRunIds.filter(
            (childRunId) => !durableTerminalChildRunIds.has(childRunId),
          );
          if (runtimeChildRunIds.length === 0) {
            return {
              ok: true,
              result: {
                ok: true,
                completed: [],
                pending: [],
                blocked: [],
              },
            };
          }
          const nextOutcome = await waitForChildren(
            runtimeChildRunIds,
            requestedWaitMode,
            signal,
          );
          if (
            nextOutcome.ok ||
            nextOutcome.errorCode !== 'invalid_args' ||
            !nextOutcome.message.startsWith('unknown child run:')
          ) {
            return nextOutcome;
          }
          const missingChildRunIds = runtimeChildRunIds.filter(
            (childRunId) => registry.getChildRun(childRunId) === undefined,
          );
          const terminalRead = refreshDurableTerminalOutcomes();
          if (!terminalRead.ok) {
            return terminalRead;
          }
          if (
            missingChildRunIds.length === 0 ||
            !missingChildRunIds.every((childRunId) =>
              durableTerminalChildRunIds.has(childRunId),
            )
          ) {
            return nextOutcome;
          }
        }
      };
      if (waitMode === 'snapshot') {
        if (launchRequestStore !== undefined) {
          try {
            durableLaunches = childRunIds.flatMap((childRunId) => {
              const request =
                launchRequestStore.readSubagentLaunchRequestByChildRunId(
                  childRunId,
                );
              return request === undefined ? [] : [request];
            });
          } catch {
            return toolError(
              'persistence_unavailable',
              'agent launch status could not be read',
            );
          }
          const foreignLaunch = durableLaunches.find(
            (request) => request.ownerThreadId !== ownerThreadId,
          );
          if (foreignLaunch !== undefined) {
            return toolError(
              'invalid_args',
              `child run does not belong to current owner thread: ${foreignLaunch.childRunId}`,
            );
          }
        }

        const durableChildRunIds = new Set(
          durableLaunches.map((request) => request.childRunId),
        );
        let runtimeChildRunIds = childRunIds.filter(
          (childRunId) =>
            !durableTerminalChildRunIds.has(childRunId) &&
            registry.getChildRun(childRunId) !== undefined,
        );
        let unknownChildRunId = childRunIds.find(
          (childRunId) =>
            !durableChildRunIds.has(childRunId) &&
            !durableTerminalChildRunIds.has(childRunId) &&
            registry.getChildRun(childRunId) === undefined,
        );
        if (unknownChildRunId !== undefined) {
          const terminalRead = refreshDurableTerminalOutcomes();
          if (!terminalRead.ok) {
            return toolError(terminalRead.errorCode, terminalRead.message);
          }
          runtimeChildRunIds = childRunIds.filter(
            (childRunId) =>
              !durableTerminalChildRunIds.has(childRunId) &&
              registry.getChildRun(childRunId) !== undefined,
          );
          unknownChildRunId = childRunIds.find(
            (childRunId) =>
              !durableChildRunIds.has(childRunId) &&
              !durableTerminalChildRunIds.has(childRunId) &&
              registry.getChildRun(childRunId) === undefined,
          );
        }
        if (unknownChildRunId !== undefined) {
          return toolError(
            'invalid_args',
            `unknown child run: ${unknownChildRunId}`,
          );
        }
        outcome =
          runtimeChildRunIds.length === 0
            ? {
                ok: true,
                result: {
                  ok: true,
                  completed: [],
                  pending: [],
                  blocked: [],
                },
              }
            : await waitForChildrenWithDurableRecovery(
                runtimeChildRunIds,
                'snapshot',
                ctx.signal,
              );
      } else {
        const waitChildRunIds = childRunIds;
        if (interjectBuffer === undefined) {
          outcome = await waitForChildrenWithDurableRecovery(
            waitChildRunIds,
            waitMode,
            ctx.signal,
          );
        } else {
          const waitAbortController = new AbortController();
          const forwardCallerAbort = () => {
            waitAbortController.abort(ctx.signal?.reason);
          };
          if (ctx.signal?.aborted) {
            forwardCallerAbort();
          } else {
            ctx.signal?.addEventListener('abort', forwardCallerAbort, {
              once: true,
            });
          }

          const childWait = waitForChildrenWithDurableRecovery(
            waitChildRunIds,
            waitMode,
            waitAbortController.signal,
          ).then((result) => ({ kind: 'children' as const, result }));
          let unsubscribeInterjectFlush = () => {};
          const interjectFlush = new Promise<{
            kind: 'interject_flush';
          }>((resolve) => {
            unsubscribeInterjectFlush = interjectBuffer.subscribeFlush(() =>
              resolve({ kind: 'interject_flush' }),
            );
          });

          const settled = await Promise.race([childWait, interjectFlush]);
          unsubscribeInterjectFlush();
          ctx.signal?.removeEventListener('abort', forwardCallerAbort);
          if (settled.kind === 'children') {
            outcome = settled.result;
          } else {
            waitAbortController.abort('interject flush requested');
            const interruptedWait = await childWait;
            outcome = ctx.signal?.aborted
              ? interruptedWait.result
              : await waitForChildrenWithDurableRecovery(
                  waitChildRunIds,
                  'snapshot',
                );
          }
        }
      }
      if (!outcome.ok) {
        return toolError(outcome.errorCode, outcome.message);
      }
      const finalTerminalRead = refreshDurableTerminalOutcomes();
      if (!finalTerminalRead.ok) {
        return toolError(
          finalTerminalRead.errorCode,
          finalTerminalRead.message,
        );
      }
      const completedByChildRunId = new Map<
        RunId,
        | (typeof outcome.result.completed)[number]
        | ReturnType<typeof projectDurableTerminalStatus>
      >();
      for (const entry of outcome.result.completed) {
        completedByChildRunId.set(entry.childRunId, entry);
      }
      for (const terminal of durableTerminalOutcomes) {
        completedByChildRunId.set(
          terminal.result.childRunId,
          projectDurableTerminalStatus(terminal, resultMode),
        );
      }
      const completed = childRunIds.flatMap((childRunId) => {
        const terminal = completedByChildRunId.get(childRunId);
        return terminal === undefined ? [] : [terminal];
      });
      const mergedResult = {
        ...outcome.result,
        completed,
        pending: outcome.result.pending.filter(
          (childRunId) => !durableTerminalChildRunIds.has(childRunId),
        ),
        blocked: outcome.result.blocked.filter(
          (entry) => !durableTerminalChildRunIds.has(entry.childRunId),
        ),
      };
      registry.claimTerminalChildRuns({
        ownerThreadId,
        childRunIds: completed.map((entry) => entry.childRunId),
      });
      return {
        ok: true,
        output: JSON.stringify({
          ...mergedResult,
          ...(durableLaunches.length === 0
            ? {}
            : {
                launches: durableLaunches.map(projectDurableLaunchStatus),
              }),
        }),
      };
    },
  });
}

function projectDurableLaunchStatus(request: DurableSubagentLaunchRequest) {
  return {
    childRunId: request.childRunId,
    childThreadId: request.childThreadId,
    ...(request.previousChildRunId === null
      ? {}
      : { previousChildRunId: request.previousChildRunId }),
    launchState: request.launchState,
    priorityClass: request.priorityClass,
    enqueueOrder: request.enqueueOrder,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    runtime: request.runtime,
    ...(request.deferReason === null
      ? {}
      : { deferReason: request.deferReason }),
    ...(request.failureReason === null
      ? {}
      : { failureReason: request.failureReason }),
  };
}

function projectDurableTerminalStatus(
  terminal: DurableSubagentTerminalOutcome,
  resultMode: AgentWaitResultMode,
) {
  const result = terminal.result;
  return {
    deliveryId: result.deliveryId,
    childRunId: result.childRunId,
    terminalState: result.terminalState,
    ok: result.terminalState === 'completed',
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(resultMode === 'inline' ? { result: result.result } : {}),
    parentRunId: result.parentRunId,
    ...(result.childThreadId === undefined
      ? {}
      : { childThreadId: result.childThreadId }),
    subagentType: result.subagentType,
    ...(result.capabilities === undefined || result.toolSurface === undefined
      ? {}
      : {
          capabilities: result.capabilities,
          toolSurface: result.toolSurface,
        }),
    ...(result.runtime === undefined ? {} : { runtime: result.runtime }),
    completedAt: result.completedAt,
    ...(result.elapsedMs === undefined ? {} : { elapsedMs: result.elapsedMs }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
    ...(result.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: result.reasoningEffort }),
    resultRef: terminal.resultRef,
    resultDigest: terminal.resultDigest,
    ...(result.resultReport === undefined
      ? {}
      : { resultReport: result.resultReport }),
  };
}

export const agentWaitTool = createAgentWaitTool();
