import type { RunEvent } from '@geulbat/protocol/run-events';

import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

type SubagentRunEvent = Extract<
  RunEvent,
  | { type: 'subagent_spawned' }
  | { type: 'subagent_approval_required' }
  | { type: 'subagent_terminal' }
>;

interface RunSessionSubagentActivityEffect {
  kind: 'subagent_activity_added';
  threadId: string;
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>;
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
          childRunId: event.payload.childRunId,
          subagentType: event.payload.subagentType,
          state: 'spawned',
        },
      };
    case 'subagent_approval_required':
      return {
        kind: 'subagent_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'subagent_activity',
          childRunId: event.payload.childRunId,
          subagentType: event.payload.subagentType,
          state: 'approval_required',
        },
      };
    case 'subagent_terminal':
      return {
        kind: 'subagent_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'subagent_activity',
          deliveryId: event.payload.deliveryId,
          childRunId: event.payload.childRunId,
          subagentType: event.payload.subagentType,
          state: event.payload.terminalState,
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          ...(event.payload.result ? { result: event.payload.result } : {}),
        },
      };
  }
}
