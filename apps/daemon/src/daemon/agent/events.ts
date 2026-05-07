import type {
  AgentEvent,
  AgentEventPayloadMap,
  AgentEventType,
} from '../runtime-contracts.js';

export type {
  AgentEvent,
  AgentEventEmitter,
  AgentEventPayloadMap,
  AgentEventType,
  ToolCallArgs,
} from '../runtime-contracts.js';

export type AgentEventFor<Type extends AgentEventType> = AgentEvent & {
  type: Type;
  payload: AgentEventPayloadMap[Type];
};

export function createAgentEvent<Type extends AgentEventType>(
  type: Type,
  payload: AgentEventPayloadMap[Type],
): AgentEventFor<Type> {
  return { type, payload } as AgentEventFor<Type>;
}
