import { randomUUID } from 'node:crypto';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { RunId, RunSubagentModelRouting } from './contract.js';

import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { RunContext } from '../run-context.js';
import type { AgentEvent, ToolRunState } from '../runtime-contracts.js';
import type {
  SubagentLaunchReservation,
  SubagentType,
  ResolvedChildModelPin,
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
  parentRunId: RunId;
  ownerThreadId: RunContext['threadId'];
  startedChildRun: StartedChildRunHandle;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation: SubagentLaunchReservation | undefined;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  emitAgentEvent: ((event: AgentEvent) => void) | undefined;
  timeoutMs?: number;
}): BackgroundChildLifecycle {
  const {
    subagentType,
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
  };

  try {
    launchReservation?.release();

    runtimeServices.childRuns.registerChildRun({
      childRunId,
      childThreadId,
      parentRunId,
      ownerThreadId,
      subagentType,
      modelPin,
      subagentModelRouting,
    });
    childRegistryRegistered = true;

    emitAgentEvent?.({
      type: 'subagent_spawned',
      payload: {
        parentRunId,
        childRunId,
        childThreadId,
        subagentType,
        modelId: modelPin.modelId,
        reasoningEffort: modelPin.providerRunSelection.reasoningEffort,
        selectionSource: modelPin.selectionSource,
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
        elapsedMs: readChildElapsedMs(childRunState),
        usageTotals: childRunState.usageTotals,
        modelPin,
      });
    },
  };
}

function publishBackgroundChildTerminalOutcome(args: {
  outcome: ChildTerminalOutcome;
  runtimeServices: AgentRuntimeServices;
  ownerThreadId: RunContext['threadId'];
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: RunContext['threadId'];
  subagentType: SubagentType;
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
  runChildLifecycleStep('publish background child terminal result', () => {
    runtimeServices.backgroundNotifications.enqueueThreadBackgroundResult(
      ownerThreadId,
      {
        deliveryId: randomUUID(),
        parentRunId,
        childRunId,
        childThreadId,
        subagentType,
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
