import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentEvent, type AgentEventPayloadMap } from './events.js';
import type { AgentEvent } from './events.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const commentaryEvent = createAgentEvent('commentary_delta', {
  text: 'from-event-test',
});

type _CreateAgentEventReturnsNarrowEvent = Expect<
  Equal<(typeof commentaryEvent)['type'], 'commentary_delta'>
>;
type _CreateAgentEventKeepsNarrowPayload = Expect<
  Equal<
    (typeof commentaryEvent)['payload'],
    AgentEventPayloadMap['commentary_delta']
  >
>;
const _eventIsStillAnAgentEvent: AgentEvent = commentaryEvent;

void test('createAgentEvent returns a canonical event object', () => {
  assert.deepEqual(commentaryEvent, {
    type: 'commentary_delta',
    payload: { text: 'from-event-test' },
  });
});
