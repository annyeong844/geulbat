import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beginConnectionAttempt,
  canScheduleReconnect,
  clearReconnectSchedule,
  createInitialRunChannelConnectionState,
  markAuthHandshakeStarted,
  markConnectionClosed,
  markConnectionReady,
  markReconnectScheduled,
} from './client-state.js';

void test('run-channel client state tracks explicit connection phases', () => {
  let state = createInitialRunChannelConnectionState();
  assert.equal(state.phase, 'idle');

  state = beginConnectionAttempt(state);
  assert.equal(state.phase, 'connecting');
  assert.equal(state.closedExplicitly, false);

  state = markAuthHandshakeStarted(state);
  assert.equal(state.phase, 'authenticating');

  state = markConnectionReady({
    ...state,
    reconnectAttempts: 3,
    reconnectTask: 42,
  });
  assert.equal(state.phase, 'connected');
  assert.equal(state.reconnectAttempts, 0);
  assert.equal(state.reconnectTask, null);
});

void test('run-channel client state keeps reconnect scheduling explicit', () => {
  let state = createInitialRunChannelConnectionState();
  assert.equal(canScheduleReconnect(state), true);

  state = markReconnectScheduled(state, 99);
  assert.equal(state.phase, 'reconnecting');
  assert.equal(state.reconnectAttempts, 1);
  assert.equal(canScheduleReconnect(state), false);

  state = clearReconnectSchedule(state);
  assert.equal(state.phase, 'idle');
  assert.equal(state.reconnectTask, null);

  state = markConnectionClosed(state, true);
  assert.equal(state.phase, 'closed');
  assert.equal(canScheduleReconnect(state), false);
});

void test('run-channel client state keeps reconnect eligible without a retry ceiling', () => {
  let state = createInitialRunChannelConnectionState();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = markReconnectScheduled(state, attempt + 1);
    assert.equal(canScheduleReconnect(state), false);
    state = clearReconnectSchedule(state);
    assert.equal(canScheduleReconnect(state), true);
  }
});
