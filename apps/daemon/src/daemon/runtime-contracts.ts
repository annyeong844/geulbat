import type {
  AgentChildTerminalState,
  SharedRunEventPayloadMap,
} from '@geulbat/protocol/run-events';
import type { RunId } from '@geulbat/protocol/ids';

export type ToolCallArgs = SharedRunEventPayloadMap['tool_call']['args'];

export type AgentEventPayloadMap = SharedRunEventPayloadMap;

export type AgentEventType = keyof AgentEventPayloadMap;

export type AgentEvent = {
  [Type in AgentEventType]: {
    type: Type;
    payload: AgentEventPayloadMap[Type];
  };
}[AgentEventType];

export type AgentEventEmitter = <Type extends AgentEventType>(
  type: Type,
  payload: AgentEventPayloadMap[Type],
) => void;

export type RunStatus =
  | 'running'
  | 'awaiting_approval'
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
