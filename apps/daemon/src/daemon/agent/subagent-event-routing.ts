import type { RunId } from '@geulbat/protocol/ids';

import type { ChildRunRegistry } from './runtime/child-run-registry.js';
import type { AgentEvent } from '../runtime-contracts.js';
import type { SubagentType } from '../subagent-runtime-contracts.js';

export function routeChildAgentEvent(args: {
  event: AgentEvent;
  parentRunId: RunId;
  childRunId: RunId;
  subagentType: SubagentType;
  childRuns: Pick<
    ChildRunRegistry,
    'markChildApprovalPending' | 'markChildRunning'
  >;
  emitAgentEvent?: (event: AgentEvent) => void;
}): string | undefined {
  const {
    event,
    parentRunId,
    childRunId,
    subagentType,
    childRuns,
    emitAgentEvent,
  } = args;

  if (event.type === 'approval_required') {
    childRuns.markChildApprovalPending(childRunId);
    emitAgentEvent?.({
      type: 'subagent_approval_required',
      payload: {
        parentRunId,
        childRunId,
        subagentType,
        approval: event.payload,
      },
    });
    emitAgentEvent?.(event);
    return undefined;
  }

  childRuns.markChildRunning(childRunId);
  if (event.type === 'error' && typeof event.payload.message === 'string') {
    return event.payload.message;
  }
  return undefined;
}
