import type { GenericApiErrorCode } from '../error-codes.js';
import type { AgentResult } from './agent-result.js';
import type { AgentEventEmitter } from './events.js';
import { emitTerminalFailure } from './loop-shared.js';
import { settleRunAfterResult, type RunState } from './runtime/run-state.js';

interface SettleAgentLoopResultArgs {
  runState?: RunState | undefined;
  result: AgentResult;
  signal?: AbortSignal | undefined;
}

interface CreateAgentLoopTerminalFailureArgs {
  emit: AgentEventEmitter;
  code: GenericApiErrorCode;
  message: string;
}

export interface AgentLoopLifecyclePort {
  settleAfterResult(args: SettleAgentLoopResultArgs): void;
  createTerminalFailure(args: CreateAgentLoopTerminalFailureArgs): AgentResult;
}

export function createAgentLoopLifecyclePort(): AgentLoopLifecyclePort {
  return {
    settleAfterResult(args) {
      settleRunAfterResult(args.runState, args.result, args.signal);
    },
    createTerminalFailure(args) {
      return emitTerminalFailure(args.emit, args.code, args.message);
    },
  };
}
