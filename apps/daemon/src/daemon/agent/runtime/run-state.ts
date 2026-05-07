import { isAgentChildTerminalState } from '@geulbat/protocol/run-events';
import { assertRunId, type RunId } from '@geulbat/protocol/ids';
import type { RunWorkspaceContext } from '../../run-workspace-context.js';
import { createRunWorkspaceContext } from '../../run-workspace-context.js';
import type { RunStatus, ToolRunState } from '../../runtime-contracts.js';
import { hasVisibleAgentOutput } from '../agent-result.js';
import type { AgentResult } from '../agent-result.js';

export interface RunState extends RunWorkspaceContext, ToolRunState {}

export function createRunState(params: {
  runId: string | RunId;
  runContext: RunWorkspaceContext;
  parentRunId?: string | RunId;
}): RunState {
  const runContext = createRunWorkspaceContext(params.runContext);
  const runId = assertRunId(params.runId);
  const parentRunId =
    params.parentRunId !== undefined ? assertRunId(params.parentRunId) : null;
  return {
    runId,
    ...runContext,
    seq: 0,
    abortController: new AbortController(),
    status: 'running',
    createdAt: new Date().toISOString(),
    childRunIds: new Set<RunId>(),
    backgroundChildRunIds: new Set<RunId>(),
    backgroundChildLaunchReservationIds: new Set<string>(),
    ...(parentRunId !== null ? { parentRunId } : {}),
  };
}

export function nextSeq(state: RunState): number {
  state.seq += 1;
  return state.seq;
}

function transitionRunStatus(state: RunState, status: RunStatus): RunState {
  if (!isValidRunStatusTransition(state.status, status)) {
    throw new Error(
      `invalid run status transition: ${state.status} -> ${status}`,
    );
  }
  state.status = status;
  return state;
}

function isValidRunStatusTransition(
  current: RunStatus,
  next: RunStatus,
): boolean {
  if (current === next) {
    return true;
  }

  switch (current) {
    case 'running':
      return (
        next === 'awaiting_approval' ||
        next === 'completed' ||
        next === 'failed' ||
        next === 'cancelled'
      );
    case 'awaiting_approval':
      return next === 'running' || next === 'failed' || next === 'cancelled';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return false;
  }
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return isAgentChildTerminalState(status);
}

export function markRunAwaitingApproval(state: RunState): RunState {
  return transitionRunStatus(state, 'awaiting_approval');
}

export function markRunRunning(state: RunState): RunState {
  return transitionRunStatus(state, 'running');
}

export function completeRun(state: RunState): RunState {
  return transitionRunStatus(state, 'completed');
}

function failRun(state: RunState): RunState {
  return transitionRunStatus(state, 'failed');
}

export function cancelRun(state: RunState): RunState {
  return transitionRunStatus(state, 'cancelled');
}

export function failOrCancelRun(
  state: RunState,
  signal?: AbortSignal,
): RunState {
  return signal?.aborted ? cancelRun(state) : failRun(state);
}

export type RunFailureOutcome = 'failed' | 'cancelled' | 'signal';

export function settleRunAfterTerminalFailure(
  state: RunState | undefined,
  signal?: AbortSignal,
  outcome?: RunFailureOutcome,
): RunState | undefined {
  if (!state || isTerminalRunStatus(state.status)) {
    return state;
  }

  switch (outcome) {
    case 'failed':
      return failRun(state);
    case 'cancelled':
      return cancelRun(state);
    case 'signal':
    case undefined:
      return failOrCancelRun(state, signal);
  }
}

export function settleRunAfterResult(
  state: RunState | undefined,
  result: AgentResult,
  signal?: AbortSignal,
): RunState | undefined {
  if (!state || isTerminalRunStatus(state.status)) {
    return state;
  }

  if (hasVisibleAgentOutput(result)) {
    return completeRun(state);
  }

  return settleRunAfterTerminalFailure(state, signal, 'signal');
}

export function registerChildRun(
  parentState: ToolRunState,
  params: {
    childRunId: RunId;
    childAbortController: AbortController;
    background?: boolean;
  },
): { deregister: () => void } {
  parentState.childRunIds.add(params.childRunId);
  if (params.background) {
    parentState.backgroundChildRunIds.add(params.childRunId);
  }

  if (!params.background && parentState.abortController.signal.aborted) {
    params.childAbortController.abort(
      parentState.abortController.signal.reason,
    );
  }

  const onParentAbort = () => {
    params.childAbortController.abort(
      parentState.abortController.signal.reason,
    );
  };

  if (!params.background) {
    parentState.abortController.signal.addEventListener(
      'abort',
      onParentAbort,
      { once: true },
    );
  }

  return {
    deregister: () => {
      parentState.childRunIds.delete(params.childRunId);
      parentState.backgroundChildRunIds.delete(params.childRunId);
      if (!params.background) {
        parentState.abortController.signal.removeEventListener(
          'abort',
          onParentAbort,
        );
      }
    },
  };
}

export function countActiveBackgroundChildren(state: ToolRunState): number {
  return (
    state.backgroundChildRunIds.size +
    state.backgroundChildLaunchReservationIds.size
  );
}
