import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getShellAuthFailureWindowCountForTests,
  MAX_SHELL_AUTH_FAILURE_WINDOWS,
  recordShellAuthFailure,
  resetShellAuthFailureRateLimitForTests,
} from './auth-failure-rate-limit.js';

void test('recordShellAuthFailure prunes expired auth windows as new failures arrive', () => {
  resetShellAuthFailureRateLimitForTests();

  recordShellAuthFailure('127.0.0.1', 0);
  recordShellAuthFailure('127.0.0.2', 0);
  assert.equal(getShellAuthFailureWindowCountForTests(), 2);

  recordShellAuthFailure('127.0.0.3', 61_000);
  assert.equal(getShellAuthFailureWindowCountForTests(), 1);
});

void test('recordShellAuthFailure caps the number of tracked auth windows', () => {
  resetShellAuthFailureRateLimitForTests();

  for (let i = 0; i <= MAX_SHELL_AUTH_FAILURE_WINDOWS; i += 1) {
    recordShellAuthFailure(`10.0.0.${i}`, i);
  }

  assert.equal(
    getShellAuthFailureWindowCountForTests(),
    MAX_SHELL_AUTH_FAILURE_WINDOWS,
  );
});

void test('recordShellAuthFailure prunes capped windows without Array.shift reindexing', () => {
  resetShellAuthFailureRateLimitForTests();

  for (let i = 0; i < MAX_SHELL_AUTH_FAILURE_WINDOWS; i += 1) {
    recordShellAuthFailure(`10.0.1.${i}`, i);
  }

  const originalShift = Array.prototype.shift;
  let shiftCalls = 0;
  Array.prototype.shift = function patchedShift<T>(this: T[]): T | undefined {
    shiftCalls += 1;
    return originalShift.call(this);
  };

  try {
    recordShellAuthFailure('10.0.1.new', MAX_SHELL_AUTH_FAILURE_WINDOWS + 1);
  } finally {
    Array.prototype.shift = originalShift;
  }

  assert.equal(
    getShellAuthFailureWindowCountForTests(),
    MAX_SHELL_AUTH_FAILURE_WINDOWS,
  );
  assert.equal(shiftCalls, 0);
});
