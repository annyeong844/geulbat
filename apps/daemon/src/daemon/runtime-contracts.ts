import type {
  SharedRunEventPayloadMap,
  ToolOutputDeltaEventPayload,
} from '@geulbat/protocol/run-events';
import type { AgentChildTerminalState } from '@geulbat/protocol/subagent-terminal';
import type { RunId } from '@geulbat/protocol/ids';
import type { RunProviderId } from '@geulbat/protocol/run-contract';
import {
  isProviderReplayScopeId as isProtocolProviderReplayScopeId,
  type ProviderReplayScopeId,
} from '@geulbat/protocol/provider-auth';

export type { ProviderReplayScopeId, RunProviderId };

export function isProviderReplayScopeId(
  value: unknown,
): value is ProviderReplayScopeId {
  return isProtocolProviderReplayScopeId(value);
}

export type ToolCallArgs = SharedRunEventPayloadMap['tool_call']['args'];

interface AgentTransientEventPayloadMap {
  tool_output_delta: ToolOutputDeltaEventPayload;
}

export type AgentEventPayloadMap = SharedRunEventPayloadMap &
  AgentTransientEventPayloadMap;

export type AgentEventType = keyof AgentEventPayloadMap;

export type AgentEvent = {
  [Type in AgentEventType]: {
    type: Type;
    payload: AgentEventPayloadMap[Type];
  };
}[AgentEventType];

export type TerminalAgentEvent = Extract<
  AgentEvent,
  { type: 'done' | 'error' }
>;

export type TransientAgentEvent = Extract<
  AgentEvent,
  { type: keyof AgentTransientEventPayloadMap }
>;

export type RunEventAgentEvent = Exclude<AgentEvent, TransientAgentEvent>;

export type AgentEventEmitter = <Type extends AgentEventType>(
  type: Type,
  payload: AgentEventPayloadMap[Type],
) => void;

export const RUN_RUNNING_STATUS = 'running' as const;
export const RUN_APPROVAL_PENDING_STATUS = 'approval_pending' as const;

export type RunStatus =
  | typeof RUN_RUNNING_STATUS
  | typeof RUN_APPROVAL_PENDING_STATUS
  | AgentChildTerminalState;

export interface ToolRunState {
  runId: RunId;
  seq: number;
  abortController: AbortController;
  status: RunStatus;
  createdAt: string;
  parentRunId?: RunId;
  childRunIds: Set<RunId>;
  backgroundChildRunIds: Set<RunId>;
  backgroundChildLaunchReservationIds: Set<string>;
  subagentResultReportSummary?: string;
}

export type RootToolRunState = ToolRunState & { parentRunId?: undefined };
export type ChildToolRunState = ToolRunState & { parentRunId: RunId };

export function isRootRunState(state: ToolRunState): state is RootToolRunState {
  return state.parentRunId === undefined;
}

export function isChildRunState(
  state: ToolRunState,
): state is ChildToolRunState {
  return state.parentRunId !== undefined;
}
