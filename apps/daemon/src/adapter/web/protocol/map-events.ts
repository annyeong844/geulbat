import {
  isArtifactCommittedEventPayload,
  isDoneEventPayload,
  isErrorEventPayload,
  isInterjectAppliedEventPayload,
  isRunAckEventPayload,
  isSubagentApprovalRequiredEventPayload,
  isSubagentSpawnedEventPayload,
  isSubagentTerminalEventPayload,
  isThreadStatePersistedEventPayload,
  isThreadStatePersistFailedEventPayload,
  isTextDeltaEventPayload,
  isToolCallEventPayload,
  isToolResultEventPayload,
} from '@geulbat/protocol/run-events';
import { isApprovalRequired as isProtocolApprovalRequired } from '@geulbat/protocol/run-approval';
import type {
  RunEvent,
  RunEventEnvelope,
  RunEventPayloadMap,
} from '@geulbat/protocol/run-events';
import type { ThreadId } from '@geulbat/protocol/ids';
import type { AgentEvent } from '../../../daemon/agent/events.js';
import type {
  AgentEventPayloadMap,
  AgentEventType,
} from '../../../daemon/agent/events.js';
type RunId = RunEvent['runId'];

const agentEventPayloadGuards: {
  [K in AgentEventType]: (value: unknown) => value is AgentEventPayloadMap[K];
} = {
  run_ack: isRunAckEventPayload,
  commentary_delta: isTextDeltaEventPayload,
  final_answer_delta: isTextDeltaEventPayload,
  artifact_committed: isArtifactCommittedEventPayload,
  thread_state_persisted: isThreadStatePersistedEventPayload,
  thread_state_persist_failed: isThreadStatePersistFailedEventPayload,
  done: isDoneEventPayload,
  tool_call: isToolCallEventPayload,
  tool_result: isToolResultEventPayload,
  subagent_spawned: isSubagentSpawnedEventPayload,
  subagent_terminal: isSubagentTerminalEventPayload,
  subagent_approval_required: isSubagentApprovalRequiredEventPayload,
  interject_applied: isInterjectAppliedEventPayload,
  approval_required: isProtocolApprovalRequired,
  error: isErrorEventPayload,
};

/**
 * Convert internal AgentEvent to protocol RunEventEnvelope.
 * adapter/web owns this translation — daemon internals never import protocol.
 *
 * Invalid payloads intentionally throw here:
 * - this mapper sits on the adapter boundary, not on untrusted external input
 * - caller (`run-channel.executeRun`) treats mapper failures as unexpected internal
 *   errors and degrades the current run to a generic `error` event
 */
export function mapAgentEventToRunEvent(
  runId: RunId,
  threadId: ThreadId,
  seq: number,
  agentEvent: AgentEvent,
): RunEvent {
  switch (agentEvent.type) {
    case 'run_ack':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'commentary_delta':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'final_answer_delta':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'artifact_committed':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'thread_state_persisted':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'thread_state_persist_failed':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'done':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'tool_call':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'tool_result':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'subagent_spawned':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'subagent_terminal':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'subagent_approval_required':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'interject_applied':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'approval_required':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    case 'error':
      return buildRunEventFromAgentEvent(runId, threadId, seq, agentEvent);
    default:
      return assertNeverAgentEvent(agentEvent);
  }
}

export function mapBackgroundSubagentTerminalToRunEvent(
  runId: RunId,
  threadId: ThreadId,
  seq: number,
  payload: RunEventPayloadMap['subagent_terminal'],
): RunEvent {
  return buildValidatedRunEvent(
    runId,
    threadId,
    seq,
    'subagent_terminal',
    payload,
  );
}

function buildValidatedRunEvent<K extends AgentEventType>(
  runId: RunId,
  threadId: ThreadId,
  seq: number,
  type: K,
  payload: unknown,
): RunEventEnvelope<K> {
  const guard = agentEventPayloadGuards[type];
  if (!guard(payload)) {
    throw new Error(`invalid ${type} payload`);
  }
  return {
    runId,
    threadId,
    seq,
    type,
    ts: new Date().toISOString(),
    payload,
  };
}

function buildRunEventFromAgentEvent<K extends AgentEventType>(
  runId: RunId,
  threadId: ThreadId,
  seq: number,
  agentEvent: Extract<AgentEvent, { type: K }>,
): RunEventEnvelope<K> {
  return buildValidatedRunEvent(
    runId,
    threadId,
    seq,
    agentEvent.type,
    agentEvent.payload,
  );
}

function assertNeverAgentEvent(value: never): never {
  throw new Error(`unhandled agent event: ${String(value)}`);
}
