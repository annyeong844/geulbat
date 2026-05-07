import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
} from '../subagent-runtime-contracts.js';
import {
  describeAgentResultForTextSurface,
  type AgentResult,
} from './agent-result.js';

export interface ChildTerminalOutcome {
  terminalState: AgentChildTerminalState;
  terminalReason: AgentChildTerminalReason | null;
  terminalResult: string;
}

export function buildChildResultTerminalOutcome(args: {
  result: AgentResult;
  terminalMessage: string;
}): ChildTerminalOutcome {
  const { result, terminalMessage } = args;
  return {
    terminalState: result.ok ? 'completed' : 'failed',
    terminalReason: result.ok ? null : 'child_error',
    terminalResult:
      describeAgentResultForTextSurface(result) ||
      (result.ok ? '' : terminalMessage || 'sub-agent failed'),
  };
}

export function buildChildErrorTerminalOutcome(args: {
  abortSignal: AbortSignal;
  isTimedOut: boolean;
  terminalMessage: string;
}): ChildTerminalOutcome {
  const { abortSignal, isTimedOut, terminalMessage } = args;
  if (abortSignal.aborted) {
    return {
      terminalState: 'cancelled',
      terminalReason: resolveChildAbortTerminalReason({
        abortReason: abortSignal.reason,
        isTimedOut,
      }),
      terminalResult: terminalMessage || 'sub-agent cancelled',
    };
  }

  return {
    terminalState: 'failed',
    terminalReason: 'child_error',
    terminalResult: terminalMessage || 'sub-agent failed',
  };
}

function resolveChildAbortTerminalReason(args: {
  abortReason: unknown;
  isTimedOut: boolean;
}): AgentChildTerminalReason {
  const { abortReason, isTimedOut } = args;
  if (isTimedOut) {
    return 'timeout';
  }
  return abortReason === 'explicit_stop' ? 'explicit_stop' : 'user_interrupt';
}
