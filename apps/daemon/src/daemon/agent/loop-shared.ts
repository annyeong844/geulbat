import {
  settleRunAfterTerminalFailure,
  type RunFailureOutcome,
  type RunState,
} from './runtime/run-state.js';
import type { AgentEventEmitter } from './events.js';
import type { AgentResult } from './agent-result.js';
import type { BackgroundChildResult } from '../subagent-runtime-contracts.js';
import type { GenericApiErrorCode } from '../error-codes.js';

export type StepResult<T> =
  | { ok: true; value: T }
  | { ok: false; result: AgentResult };

export const MAX_TOOL_ROUNDS = 25;

export function emitInternalError(emit: AgentEventEmitter): void {
  emit('error', { code: 'internal', message: 'internal server error' });
}

export function emitTerminalFailure(
  emit: AgentEventEmitter,
  code: GenericApiErrorCode,
  message: string,
): AgentResult {
  emit('error', { code, message });
  return { ok: false, finalProse: '' };
}

export function emitAndSettleTerminalFailure(
  emit: AgentEventEmitter,
  code: GenericApiErrorCode,
  message: string,
  runState?: RunState,
  signal?: AbortSignal,
  outcome?: RunFailureOutcome,
): AgentResult {
  const result = emitTerminalFailure(emit, code, message);
  settleRunAfterTerminalFailure(runState, signal, outcome);
  return result;
}

export function formatBackgroundResultNote(
  results: BackgroundChildResult[],
): string {
  if (results.length === 0) {
    return '';
  }

  const lines = ['Background child updates:'];
  for (const result of results) {
    const ok = result.terminalState === 'completed';
    lines.push(`- type: ${result.subagentType}`);
    lines.push(`  ok: ${ok ? 'true' : 'false'}`);
    lines.push(`  result: ${result.result || '(empty)'}`);
  }
  return lines.join('\n');
}
