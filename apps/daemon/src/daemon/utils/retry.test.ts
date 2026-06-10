import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateRetryDelayMs, retryAsync } from './retry.js';

void test('calculateRetryDelayMs applies exponential backoff and cap', () => {
  assert.equal(
    calculateRetryDelayMs({
      attemptIndex: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
    }),
    1_000,
  );
  assert.equal(
    calculateRetryDelayMs({
      attemptIndex: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
    }),
    5_000,
  );
});

void test('calculateRetryDelayMs applies deterministic jitter around the capped delay', () => {
  assert.equal(
    calculateRetryDelayMs({
      attemptIndex: 1,
      baseDelayMs: 1_000,
      jitterRatio: 0.25,
      random: () => 1,
    }),
    2_500,
  );
  assert.equal(
    calculateRetryDelayMs({
      attemptIndex: 1,
      baseDelayMs: 1_000,
      jitterRatio: 0.25,
      random: () => 0,
    }),
    1_500,
  );
});

void test('retryAsync retries until the operation succeeds', async () => {
  const sleptDelays: number[] = [];
  let attempts = 0;

  const value = await retryAsync({
    maxRetries: 2,
    run: async (attemptIndex) => {
      attempts += 1;
      if (attemptIndex < 2) {
        throw new Error(`attempt ${attemptIndex} failed`);
      }
      return `ok:${attemptIndex}`;
    },
    shouldRetry: () => true,
    delayMs: (attemptIndex) => attemptIndex + 10,
    sleep: async (delayMs) => {
      sleptDelays.push(delayMs);
    },
  });

  assert.equal(value, 'ok:2');
  assert.equal(attempts, 3);
  assert.deepEqual(sleptDelays, [10, 11]);
});

void test('retryAsync stops when shouldRetry rejects the failure', async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      retryAsync({
        maxRetries: 5,
        run: async () => {
          attempts += 1;
          throw new Error('terminal failure');
        },
        shouldRetry: () => false,
        delayMs: () => 0,
        sleep: async () => undefined,
      }),
    /terminal failure/,
  );

  assert.equal(attempts, 1);
});

void test('retryAsync stops after maxRetries are consumed', async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      retryAsync({
        maxRetries: 1,
        run: async () => {
          attempts += 1;
          throw new Error('still failing');
        },
        shouldRetry: () => true,
        delayMs: () => 0,
        sleep: async () => undefined,
      }),
    /still failing/,
  );

  assert.equal(attempts, 2);
});

void test('retryAsync rejects invalid retry settings before running', async () => {
  let didRun = false;

  await assert.rejects(
    () =>
      retryAsync({
        maxRetries: -1,
        run: async () => {
          didRun = true;
          return 'unreachable';
        },
        shouldRetry: () => true,
        delayMs: () => 0,
        sleep: async () => undefined,
      }),
    /maxRetries must be a non-negative integer/,
  );

  assert.equal(didRun, false);
});
