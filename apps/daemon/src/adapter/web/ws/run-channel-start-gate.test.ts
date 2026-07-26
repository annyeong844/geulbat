import test from 'node:test';
import assert from 'node:assert/strict';
import type { CancelRequest } from '@geulbat/protocol/cancel';

import { claimSocketRunStart } from './run-channel-start-gate.js';
import { testRunId } from '../../../test-support/run-id.js';

type RunStartGateState = Parameters<typeof claimSocketRunStart>[0];

void test('claimSocketRunStart allows another thread while the socket owns an active run', () => {
  const state = {
    activeRunIds: new Set<CancelRequest['runId']>([testRunId(1)]),
    runStartInFlightRequestId: null,
  };

  const result = claimSocketRunStart(state, 'request-1');

  assert.equal(result.ok, true);
  assert.equal(state.runStartInFlightRequestId, 'request-1');
});

void test('claimSocketRunStart rejects when another run.start is already in flight', () => {
  const state: RunStartGateState = {
    runStartInFlightRequestId: 'request-in-flight',
  };

  const result = claimSocketRunStart(state, 'request-next');

  assert.deepEqual(result, {
    ok: false,
    status: 409,
    code: 'conflict_active_run',
    message: 'socket already has a run.start request in flight',
  });
  assert.equal(state.runStartInFlightRequestId, 'request-in-flight');
});

void test('claimSocketRunStart claims the socket and only releases the matching request', () => {
  const state: RunStartGateState = {
    runStartInFlightRequestId: null,
  };

  const result = claimSocketRunStart(state, 'request-1');

  assert.equal(result.ok, true);
  assert.equal(state.runStartInFlightRequestId, 'request-1');
  state.runStartInFlightRequestId = 'request-2';
  result.release();
  assert.equal(state.runStartInFlightRequestId, 'request-2');

  const second = claimSocketRunStart(state, 'request-2');
  assert.equal(second.ok, false);
  state.runStartInFlightRequestId = 'request-1';
  result.release();
  assert.equal(state.runStartInFlightRequestId, null);
});
