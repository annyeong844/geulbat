import type { RunEvent } from '@geulbat/protocol/run-events';
import type { ThreadSubagentTerminalOutcome } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

type SubagentRunEvent = Extract<
  RunEvent,
  | { type: 'subagent_spawned' }
  | { type: 'subagent_status' }
  | { type: 'subagent_approval_required' }
  | { type: 'subagent_terminal' }
>;

interface RunSessionSubagentActivityEffect {
  kind: 'subagent_activity_added';
  threadId: string;
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>;
}

type TerminalSubagentActivitySource = Omit<
  Pick<
    ThreadSubagentTerminalOutcome,
    | 'deliveryId'
    | 'resultDeliveryState'
    | 'parentRunId'
    | 'childRunId'
    | 'childThreadId'
    | 'subagentType'
    | 'capabilities'
    | 'toolSurface'
    | 'runtime'
    | 'terminalState'
    | 'reason'
    | 'result'
    | 'resultRef'
    | 'resultDigest'
    | 'resultReport'
    | 'completedAt'
    | 'elapsedMs'
    | 'usage'
    | 'modelId'
    | 'reasoningEffort'
  >,
  'completedAt'
> & {
  completedAt?: string;
};

export function createSubagentTerminalHistoryEntry(
  outcome: ThreadSubagentTerminalOutcome,
): Extract<RunTranscriptEntry, { kind: 'subagent_activity' }> {
  return createTerminalSubagentActivityEntry(outcome);
}

export function createSubagentActivityEffect(
  event: SubagentRunEvent,
): RunSessionSubagentActivityEffect {
  switch (event.type) {
    case 'subagent_spawned':
      return {
        kind: 'subagent_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'subagent_activity',
          parentRunId: event.payload.parentRunId,
          childRunId: event.payload.childRunId,
          childThreadId: event.payload.childThreadId,
          subagentType: event.payload.subagentType,
          ...(event.payload.capabilities !== undefined
            ? { capabilities: [...event.payload.capabilities] }
            : {}),
          ...(event.payload.toolSurface !== undefined
            ? { toolSurface: event.payload.toolSurface }
            : {}),
          ...(event.payload.runtime !== undefined
            ? { runtime: event.payload.runtime }
            : {}),
          state: 'spawned',
          ...(event.payload.modelId !== undefined
            ? { modelId: event.payload.modelId }
            : {}),
          ...(event.payload.reasoningEffort !== undefined
            ? { reasoningEffort: event.payload.reasoningEffort }
            : {}),
        },
      };
    case 'subagent_status':
      return {
        kind: 'subagent_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'subagent_activity',
          parentRunId: event.payload.parentRunId,
          childRunId: event.payload.childRunId,
          childThreadId: event.payload.childThreadId,
          subagentType: event.payload.subagentType,
          ...(event.payload.capabilities !== undefined
            ? { capabilities: [...event.payload.capabilities] }
            : {}),
          ...(event.payload.toolSurface !== undefined
            ? { toolSurface: event.payload.toolSurface }
            : {}),
          ...(event.payload.runtime !== undefined
            ? { runtime: event.payload.runtime }
            : {}),
          state:
            event.payload.runtime?.phase === 'approval_pending'
              ? 'approval_required'
              : 'spawned',
          ...(event.payload.modelId !== undefined
            ? { modelId: event.payload.modelId }
            : {}),
          ...(event.payload.reasoningEffort !== undefined
            ? { reasoningEffort: event.payload.reasoningEffort }
            : {}),
        },
      };
    case 'subagent_approval_required':
      return {
        kind: 'subagent_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'subagent_activity',
          parentRunId: event.payload.parentRunId,
          childRunId: event.payload.childRunId,
          subagentType: event.payload.subagentType,
          ...(event.payload.capabilities !== undefined
            ? { capabilities: [...event.payload.capabilities] }
            : {}),
          ...(event.payload.toolSurface !== undefined
            ? { toolSurface: event.payload.toolSurface }
            : {}),
          ...(event.payload.runtime !== undefined
            ? { runtime: event.payload.runtime }
            : {}),
          state: 'approval_required',
        },
      };
    case 'subagent_terminal':
      return {
        kind: 'subagent_activity_added',
        threadId: event.threadId,
        entry: createTerminalSubagentActivityEntry(event.payload),
      };
  }
}

function createTerminalSubagentActivityEntry(
  source: TerminalSubagentActivitySource,
): Extract<RunTranscriptEntry, { kind: 'subagent_activity' }> {
  return {
    kind: 'subagent_activity',
    deliveryId: source.deliveryId,
    ...(source.resultDeliveryState === undefined
      ? {}
      : { resultDeliveryState: source.resultDeliveryState }),
    parentRunId: source.parentRunId,
    childRunId: source.childRunId,
    ...(source.childThreadId !== undefined
      ? { childThreadId: source.childThreadId }
      : {}),
    subagentType: source.subagentType,
    ...(source.capabilities !== undefined
      ? { capabilities: [...source.capabilities] }
      : {}),
    ...(source.toolSurface !== undefined
      ? { toolSurface: source.toolSurface }
      : {}),
    ...(source.runtime !== undefined ? { runtime: source.runtime } : {}),
    state: source.terminalState,
    ...(source.reason ? { reason: source.reason } : {}),
    ...(source.result ? { result: source.result } : {}),
    ...(source.resultRef ? { resultRef: source.resultRef } : {}),
    ...(source.resultDigest ? { resultDigest: source.resultDigest } : {}),
    ...(source.resultReport ? { resultReport: source.resultReport } : {}),
    ...(source.completedAt ? { completedAt: source.completedAt } : {}),
    ...(source.elapsedMs !== undefined ? { elapsedMs: source.elapsedMs } : {}),
    ...(source.usage !== undefined ? { usage: source.usage } : {}),
    ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
    ...(source.reasoningEffort !== undefined
      ? { reasoningEffort: source.reasoningEffort }
      : {}),
  };
}
