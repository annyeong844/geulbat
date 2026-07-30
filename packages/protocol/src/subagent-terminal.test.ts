import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAgentChildTerminalReason,
  isAgentChildTerminalState,
} from './subagent-terminal.js';

void test('child terminal reasons distinguish graceful daemon shutdown from restart recovery', () => {
  assert.equal(isAgentChildTerminalReason('daemon_shutdown'), true);
  assert.equal(isAgentChildTerminalReason('daemon_restart'), true);
  assert.equal(isAgentChildTerminalReason('daemon_stopped_somehow'), false);
});

void test('child terminal states stay strict', () => {
  assert.equal(isAgentChildTerminalState('completed'), true);
  assert.equal(isAgentChildTerminalState('failed'), true);
  assert.equal(isAgentChildTerminalState('cancelled'), true);
  assert.equal(isAgentChildTerminalState('blocked'), false);
});
