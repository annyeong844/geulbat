import type { AgentEvent } from '../daemon/agent/events.js';

export function withoutProviderStatus(
  events: readonly AgentEvent[],
): AgentEvent[] {
  return events.filter((event) => event.type !== 'provider_status');
}
