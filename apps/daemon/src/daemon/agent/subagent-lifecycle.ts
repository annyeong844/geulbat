import { randomUUID } from 'node:crypto';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { RunId } from '@geulbat/protocol/ids';

import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';
import type { AgentEvent, ToolRunState } from '../runtime-contracts.js';
import type {
  SubagentLaunchReservation,
  SubagentType,
} from '../subagent-runtime-contracts.js';
import { getErrorMessage } from '../utils/error.js';
import { registerChildRun, type RunState } from './runtime/run-state.js';
import type { ChildTerminalOutcome } from './subagent-terminal-outcome.js';

const logger = createLogger('agent/subagent-lifecycle');

export interface StartedChildRunHandle {
  runId: RunId;
  threadId: RunWorkspaceContext['threadId'];
  runState: RunState;
  finish: () => void;
}

export interface BackgroundChildLifecycle {
  childRunId: RunId;
  childThreadId: RunWorkspaceContext['threadId'];
  childRunState: RunState;
  isTimedOut(): boolean;
  publishTerminalOutcome(outcome: ChildTerminalOutcome): void;
}

export function beginBackgroundChildLifecycle(args: {
  subagentType: SubagentType;
  parentRunId: RunId;
  ownerThreadId: RunWorkspaceContext['threadId'];
  startedChildRun: StartedChildRunHandle;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  launchReservation: SubagentLaunchReservation | undefined;
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
  launchReservation?.release();

  runtimeServices.childRuns.registerChildRun({
    childRunId,
    childThreadId,
    parentRunId,
    ownerThreadId,
    subagentType,
  });
  emitAgentEvent?.({
    type: 'subagent_spawned',
    payload: {
      parentRunId,
      childRunId,
      childThreadId,
      subagentType,
    },
  });

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
        subagentType,
      });
    },
  };
}

function publishBackgroundChildTerminalOutcome(args: {
  outcome: ChildTerminalOutcome;
  runtimeServices: AgentRuntimeServices;
  ownerThreadId: RunWorkspaceContext['threadId'];
  parentRunId: RunId;
  childRunId: RunId;
  subagentType: SubagentType;
}): void {
  const {
    outcome,
    runtimeServices,
    ownerThreadId,
    parentRunId,
    childRunId,
    subagentType,
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
        subagentType,
        terminalState: outcome.terminalState,
        ...(outcome.terminalReason ? { reason: outcome.terminalReason } : {}),
        result: outcome.terminalResult,
        completedAt: new Date().toISOString(),
      },
    );
  });
}

function runChildLifecycleStep(label: string, run: () => void): void {
  try {
    run();
  } catch (error: unknown) {
    logger.error(`${label} failed:`, getErrorMessage(error));
  }
}
