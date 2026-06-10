import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reportInternalAppError,
  reportVisibleAppError,
} from './error-reporting.js';

void test('reportVisibleAppError logs the failure and returns the visible UI message', () => {
  const seen: unknown[][] = [];
  const logger = {
    error(...args: unknown[]) {
      seen.push(args);
    },
  };

  const message = reportVisibleAppError({
    logger,
    logContext: 'loadThreads failed',
    visiblePrefix: 'Unable to load threads.',
    error: new Error('network down'),
  });

  assert.equal(message, 'Unable to load threads. network down');
  assert.deepEqual(seen, [['loadThreads failed:', 'network down']]);
});

void test('reportInternalAppError returns the internal banner format', () => {
  const seen: unknown[][] = [];
  const logger = {
    error(...args: unknown[]) {
      seen.push(args);
    },
  };

  const message = reportInternalAppError({
    logger,
    logContext: 'run channel connect failed',
    error: new Error('socket closed'),
  });

  assert.equal(message, '[internal] socket closed');
  assert.deepEqual(seen, [['run channel connect failed:', 'socket closed']]);
});
