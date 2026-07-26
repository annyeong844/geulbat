import { randomUUID } from 'node:crypto';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { RunId, RunSubagentModelRouting } from './contract.js';

import type {
  AgentRuntimeServices,
  AgentRuntimeSubagentServices,
} from '../daemon-runtime-contract.js';

// Child lifecycle bookkeeping touches the child registry, background result
// delivery, and the durable subagent stores — declare exactly that surface
// instead of the full runtime bag.
interface SubagentLifecycleServices {
  backgroundNotifications: AgentRuntimeServices['backgroundNotifications'];
  childRuns: AgentRuntimeServices['childRuns'];
  subagent: Pick<
    AgentRuntimeSubagentServices,
    'launchRequests' | 'terminalDeliveries'
  >;
}
import type { RunContext } from '../run-context.js';
import type { AgentEvent, ToolRunState } from '../runtime-contracts.js';
import {
  resolveSubagentToolSurfaceProfile,
  type SubagentCapability,
  type SubagentLaunchReservation,
  type SubagentType,
  type ResolvedChildModelPin,
} from '../subagent-runtime-contracts.js';
import { getErrorMessage } from '../utils/error.js';
import { registerChildRun, type RunState } from './runtime/run-state.js';
import {
  hasRunUsageTotals,
  type RunUsageTotals,
} from './runtime/run-usage-totals.js';
import type { ChildTerminalOutcome } from './subagent-terminal-outcome.js';

const logger = createLogger('agent/subagent-lifecycle');

export interface StartedChildRunHandle {
  runId: RunId;
  threadId: RunContext['threadId'];
  runState: RunState;
  finish: () => void;
}

export interface BackgroundChildLifecycle {
  childRunId: RunId;
  childThreadId: RunContext['threadId'];
  childRunState: RunState;
  isTimedOut(): boolean;
  publishTerminalOutcome(outcome: ChildTerminalOutcome): void;
}

export function beginBackgroundChildLifecycle(args: {
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  parentRunId: RunId;
  ownerThreadId: RunContext['threadId'];
  startedChildRun: StartedChildRunHandle;
  parentRunState: ToolRunState;
  runtimeServices: SubagentLifecycleServices;
  launchReservation: SubagentLaunchReservation | undefined;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent: ((event: AgentEvent) => void) | undefined;
  timeoutMs?: number;
  durableLaunchRecorded?: true;
}): BackgroundChildLifecycle {
  const {
    subagentType,
    capabilities,
    parentRunId,
    ownerThreadId,
    startedChildRun,
    parentRunState,
    runtimeServices,
    launchReservation,
    modelPin,
    subagentModelRouting,
    emitAgentEvent,
    timeoutMs,
    durableLaunchRecorded,
  } = args;
  const {
    runId: childRunId,
    threadId: childThreadId,
    runState: childRunState,
    finish,
  } = startedChildRun;
  const timeoutController =
    timeoutMs !== undefined ? new AbortController() : null;
  const timeout =
    timeoutController && timeoutMs !== undefined
      ? setTimeout(() => timeoutController.abort('child timeout'), timeoutMs)
      : null;
  const childAbortForwarder = () => {
    childRunState.abortController.abort(timeoutController?.signal.reason);
  };
  timeoutController?.signal.addEventListener('abort', childAbortForwarder, {
    once: true,
  });

  const handle = registerChildRun(parentRunState, {
    childRunId,
    childAbortController: childRunState.abortController,
    background: true,
  });
  let childRegistryRegistered = false;

  const cleanupChildLifecycle = (): void => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeoutController?.signal.removeEventListener('abort', childAbortForwarder);
    runChildLifecycleStep('deregister background child handle', () => {
      handle.deregister();
    });
    runChildLifecycleStep('finish managed child run', () => {
      finish();
    });
    runChildLifecycleStep('release child capacity lease', () => {
      launchReservation?.release();
    });
  };

  try {
    const observedAt = new Date().toISOString();
    const launchRequestStore = runtimeServices.subagent.launchRequests;
    const durableLaunch =
      durableLaunchRecorded === true
        ? launchRequestStore?.readSubagentLaunchRequestByChildRunId(childRunId)
        : undefined;
    const runtime = {
      phase: 'provider_waiting' as const,
      observedAt,
      partialOutputAvailable: false,
      ...(durableLaunch?.previousChildRunId === null ||
      durableLaunch?.previousChildRunId === undefined
        ? {}
        : { previousChildRunId: durableLaunch.previousChildRunId }),
    };
    runtimeServices.childRuns.registerChildRun({
      childRunId,
      childThreadId,
      parentRunId,
      ownerThreadId,
      subagentType,
      capabilities,
      modelPin,
      subagentModelRouting,
      runtime,
    });
    childRegistryRegistered = true;
    launchReservation?.activate(childRunState);

    if (durableLaunchRecorded === true) {
      if (launchRequestStore === undefined) {
        throw new Error('durable agent launch store is unavailable');
      }
      launchRequestStore.markSubagentLaunchStarted(childRunId);
      launchRequestStore.recordSubagentRuntimeObservation({
        childRunId,
        runtime,
      });
    }

    emitAgentEvent?.({
      type: 'subagent_spawned',
      payload: {
        parentRunId,
        childRunId,
        childThreadId,
        subagentType,
        capabilities,
        toolSurface: resolveSubagentToolSurfaceProfile({
          subagentType,
          capabilities,
        }),
        modelId: modelPin.modelId,
        reasoningEffort: modelPin.providerRunSelection.reasoningEffort,
        selectionSource: modelPin.selectionSource,
        runtime,
      },
    });
  } catch (error: unknown) {
    cleanupChildLifecycle();
    if (childRegistryRegistered) {
      runChildLifecycleStep('mark failed child launch', () => {
        runtimeServices.childRuns.markChildTerminal({
          childRunId,
          terminalState: 'failed',
          result: 'sub-agent launch failed',
          reason: 'child_error',
        });
      });
    }
    throw error;
  }

  return {
    childRunId,
    childThreadId,
    childRunState,
    isTimedOut() {
      return timeoutController?.signal.aborted ?? false;
    },
    publishTerminalOutcome(outcome) {
      cleanupChildLifecycle();
      publishBackgroundChildTerminalOutcome({
        outcome,
        runtimeServices,
        ownerThreadId,
        parentRunId,
        childRunId,
        childThreadId,
        subagentType,
        capabilities,
        elapsedMs: readChildElapsedMs(childRunState),
        usageTotals: childRunState.usageTotals,
        modelPin,
      });
    },
  };
}

function publishBackgroundChildTerminalOutcome(args: {
  outcome: ChildTerminalOutcome;
  runtimeServices: SubagentLifecycleServices;
  ownerThreadId: RunContext['threadId'];
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: RunContext['threadId'];
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  elapsedMs: number | undefined;
  usageTotals: RunUsageTotals;
  modelPin: ResolvedChildModelPin;
}): void {
  const {
    outcome,
    runtimeServices,
    ownerThreadId,
    parentRunId,
    childRunId,
    childThreadId,
    subagentType,
    capabilities,
    elapsedMs,
    usageTotals,
    modelPin,
  } = args;

  runChildLifecycleStep('mark child terminal', () => {
    runtimeServices.childRuns.markChildTerminal({
      childRunId,
      terminalState: outcome.terminalState,
      result: outcome.terminalResult,
      reason: outcome.terminalReason,
    });
  });
  const runtime = runtimeServices.childRuns.getChildRun(childRunId)?.runtime;
  const deliveryId = randomUUID();
  runChildLifecycleStep('publish background child terminal result', () => {
    runtimeServices.backgroundNotifications.enqueueThreadBackgroundResult(
      ownerThreadId,
      {
        deliveryId,
        parentRunId,
        childRunId,
        childThreadId,
        subagentType,
        capabilities,
        toolSurface: resolveSubagentToolSurfaceProfile({
          subagentType,
          capabilities,
        }),
        ...(runtime === undefined ? {} : { runtime }),
        terminalState: outcome.terminalState,
        ...(outcome.terminalReason ? { reason: outcome.terminalReason } : {}),
        result: outcome.terminalResult,
        completedAt: new Date().toISOString(),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        ...(hasRunUsageTotals(usageTotals) ? { usage: usageTotals } : {}),
        modelId: modelPin.modelId,
        reasoningEffort: modelPin.providerRunSelection.reasoningEffort,
      },
    );
    const terminalStore = runtimeServices.subagent.terminalDeliveries;
    if (terminalStore === undefined) {
      return;
    }
    const durableOutcome =
      terminalStore.readSubagentTerminalOutcomeByChildRunId(childRunId);
    if (durableOutcome?.result.deliveryId !== deliveryId) {
      throw new Error(
        `durable child terminal result is unavailable: ${childRunId}`,
      );
    }
    runtimeServices.childRuns.claimTerminalChildRuns({
      ownerThreadId,
      childRunIds: [childRunId],
    });
  });
}

function readChildElapsedMs(childRunState: RunState): number | undefined {
  const startedAtMs = Date.parse(childRunState.createdAt);
  if (Number.isNaN(startedAtMs)) {
    return undefined;
  }
  return Math.max(0, Date.now() - startedAtMs);
}

function runChildLifecycleStep(label: string, run: () => void): void {
  try {
    run();
  } catch (error: unknown) {
    logger.error(`${label} failed:`, getErrorMessage(error));
  }
}
