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
  resultReportSummary?: string;
}

export function buildChildResultTerminalOutcome(args: {
  abortSignal: AbortSignal;
  isTimedOut: boolean;
  result: AgentResult;
  terminalMessage: string;
  terminalReason?: AgentChildTerminalReason | null;
}): ChildTerminalOutcome {
  const { abortSignal, isTimedOut, result, terminalMessage, terminalReason } =
    args;
  const resultText = describeAgentResultForTextSurface(result);
  if (abortSignal.aborted) {
    return buildChildErrorTerminalOutcome({
      abortSignal,
      isTimedOut,
      terminalMessage: resultText || terminalMessage,
      ...(terminalReason === undefined ? {} : { terminalReason }),
    });
  }
  return {
    terminalState: result.ok ? 'completed' : 'failed',
    terminalReason: result.ok ? null : (terminalReason ?? 'child_error'),
    terminalResult:
      resultText || (result.ok ? '' : terminalMessage || 'sub-agent failed'),
  };
}

export function buildChildErrorTerminalOutcome(args: {
  abortSignal: AbortSignal;
  isTimedOut: boolean;
  terminalMessage: string;
  terminalReason?: AgentChildTerminalReason | null;
}): ChildTerminalOutcome {
  const { abortSignal, isTimedOut, terminalMessage, terminalReason } = args;
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
    terminalReason: terminalReason ?? 'child_error',
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
  if (abortReason === 'explicit_stop') {
    return 'explicit_stop';
  }
  return abortReason === 'daemon_shutdown'
    ? 'daemon_shutdown'
    : 'user_interrupt';
}
