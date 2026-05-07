import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearRunSessionError,
  logRunSessionCommandFailure,
  reportRunSessionFailure,
} from './run-session-diagnostics.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

void test('clearRunSessionError dispatches the canonical clear action', () => {
  const actions: RunSessionStateAction[] = [];

  clearRunSessionError((action) => {
    actions.push(action);
  });

  assert.deepEqual(actions, [{ type: 'session_error_cleared' }]);
});

void test('reportRunSessionFailure logs the internal error and dispatches a visible state update', () => {
  const actions: RunSessionStateAction[] = [];
  const seen: unknown[][] = [];
  const logger = {
    error(...args: unknown[]) {
      seen.push(args);
    },
  };

  reportRunSessionFailure({
    dispatch: (action) => {
      actions.push(action);
    },
    logContext: 'run channel message failed',
    error: new Error('socket closed'),
    logger,
  });

  assert.deepEqual(actions, [
    {
      type: 'session_error_recorded',
      message: '[internal] socket closed',
    },
  ]);
  assert.deepEqual(seen, [['run channel message failed:', 'socket closed']]);
});

void test('logRunSessionCommandFailure keeps command logging at the diagnostics seam', () => {
  const seen: unknown[][] = [];
  const logger = {
    error(...args: unknown[]) {
      seen.push(args);
    },
  };

  logRunSessionCommandFailure({
    logContext: 'stream error',
    message: 'transport offline',
    logger,
  });

  assert.deepEqual(seen, [['stream error:', 'transport offline']]);
});
