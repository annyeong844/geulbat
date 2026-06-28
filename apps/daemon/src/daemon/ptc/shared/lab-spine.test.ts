import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitPtcBoundedTimeoutMs,
  admitPtcLabPolicy,
  ptcFailure,
} from './lab-spine.js';

void test('admitPtcLabPolicy admits only lab-selected profiles with lab policy', () => {
  const labPolicy = { policyId: 'ptc_lab_local_docker_v1' };

  assert.deepEqual(
    admitPtcLabPolicy({
      metadata: { selectedProfile: 'lab' },
      labPolicy,
    }),
    { ok: true, value: labPolicy },
  );

  assert.deepEqual(admitPtcLabPolicy(undefined), { ok: false });
  assert.deepEqual(
    admitPtcLabPolicy({
      metadata: { selectedProfile: 'safe_subset' },
      labPolicy,
    }),
    { ok: false },
  );
  assert.deepEqual(
    admitPtcLabPolicy({
      metadata: { selectedProfile: 'lab' },
    }),
    { ok: false },
  );
});

void test('admitPtcBoundedTimeoutMs admits explicit and default bounded integers', () => {
  assert.deepEqual(
    admitPtcBoundedTimeoutMs({
      timeoutMs: 250,
      defaultTimeoutMs: 100,
      maxTimeoutMs: 1000,
    }),
    { ok: true, value: 250 },
  );
  assert.deepEqual(
    admitPtcBoundedTimeoutMs({
      timeoutMs: undefined,
      defaultTimeoutMs: 100,
      maxTimeoutMs: 1000,
    }),
    { ok: true, value: 100 },
  );
});

void test('admitPtcBoundedTimeoutMs rejects real invalid timeout inputs', () => {
  for (const timeoutMs of [
    '1000',
    0,
    -1,
    1001,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ]) {
    assert.deepEqual(
      admitPtcBoundedTimeoutMs({
        timeoutMs,
        defaultTimeoutMs: 100,
        maxTimeoutMs: 1000,
      }),
      { ok: false },
    );
  }
});

void test('ptcFailure preserves the compact failure envelope', () => {
  assert.deepEqual(ptcFailure('ptc_example_failed', 'PTC example failed'), {
    ok: false,
    reasonCode: 'ptc_example_failed',
    message: 'PTC example failed',
  });
});

void test('ptcFailure preserves diagnostics only when present', () => {
  assert.deepEqual(
    ptcFailure('ptc_example_failed', 'PTC example failed', {
      exitCode: 1,
      stderr: 'denied',
    }),
    {
      ok: false,
      reasonCode: 'ptc_example_failed',
      message: 'PTC example failed',
      diagnostics: { exitCode: 1, stderr: 'denied' },
    },
  );
});
