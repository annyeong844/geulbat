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
  const preferDurableRefs = results.length > 1;
  for (const result of results) {
    const ok = result.terminalState === 'completed';
    lines.push(`- deliveryId: ${result.deliveryId}`);
    lines.push(`  parentRunId: ${result.parentRunId}`);
    lines.push(`  type: ${result.subagentType}`);
    lines.push(`  childRunId: ${result.childRunId}`);
    if (result.childThreadId !== undefined) {
      lines.push(`  childThreadId: ${result.childThreadId}`);
    }
    lines.push(`  terminalState: ${result.terminalState}`);
    lines.push(`  completedAt: ${result.completedAt}`);
    if (result.reason !== undefined) {
      lines.push(`  reason: ${result.reason}`);
    }
    if (result.resultRef !== undefined) {
      lines.push(`  resultRef: ${result.resultRef}`);
    }
    if (result.resultDigest !== undefined) {
      lines.push(`  resultDigest: ${result.resultDigest}`);
    }
    if (result.resultReport !== undefined) {
      lines.push(`  reportSummary: ${result.resultReport.summary}`);
      lines.push(
        `  reportSourceResultRef: ${result.resultReport.sourceResultRef}`,
      );
      lines.push(
        `  reportSourceResultDigest: ${result.resultReport.sourceResultDigest}`,
      );
    }
    lines.push(`  ok: ${ok ? 'true' : 'false'}`);
    if (preferDurableRefs && result.resultRef !== undefined) {
      lines.push('  resultMode: refs');
      lines.push(
        '  result: omitted from this multi-child fan-in note; read resultRef with read_tool_output',
      );
    } else {
      lines.push('  resultMode: inline');
      lines.push(`  result: ${result.result || '(empty)'}`);
    }
  }
  return lines.join('\n');
}
