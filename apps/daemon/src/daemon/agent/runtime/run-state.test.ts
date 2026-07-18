import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunId } from '@geulbat/protocol/ids';

import {
  cancelRun,
  completeRun,
  createRunState,
  nextSeq,
  failOrCancelRun,
  markRunApprovalPending,
  markRunRunning,
  registerChildRun,
  countActiveBackgroundChildren,
  settleRunAfterResult,
  settleRunAfterTerminalFailure,
  type RunState,
} from './run-state.js';
import { RUN_APPROVAL_PENDING_STATUS } from '../../runtime-contracts.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _RunStateUsesBrandedRunIds = Expect<Equal<RunState['runId'], RunId>>;
type _RunStateTracksBrandedChildRunIds = Expect<
  Equal<RunState['childRunIds'], Set<RunId>>
>;
type _RunStateTracksBrandedBackgroundChildRunIds = Expect<
  Equal<RunState['backgroundChildRunIds'], Set<RunId>>
>;
type _RegisterChildRunRequiresBrandedChildRunId = Expect<
  Equal<Parameters<typeof registerChildRun>[1]['childRunId'], RunId>
>;

void test('registerChildRun cascades abort and deregisters child tracking', () => {
  const childRunId = testRunId('child');
  const parent = createRunState({
    runId: 'parent',
    runContext: makeRunContext(),
  });
  const child = new AbortController();

  const handle = registerChildRun(parent, {
    childRunId,
    childAbortController: child,
    background: false,
  });

  assert.equal(parent.childRunIds.has(childRunId), true);
  assert.equal(countActiveBackgroundChildren(parent), 0);

  parent.abortController.abort('cancelled');

  assert.equal(child.signal.aborted, true);

  handle.deregister();
  assert.equal(parent.childRunIds.has(childRunId), false);
  assert.equal(countActiveBackgroundChildren(parent), 0);
});

void test('registerChildRun keeps background children alive across parent abort', () => {
  const childRunId = testRunId('child-background');
  const parent = createRunState({
    runId: 'parent',
    runContext: makeRunContext(),
  });
  const child = new AbortController();

  const handle = registerChildRun(parent, {
    childRunId,
    childAbortController: child,
    background: true,
  });

  parent.abortController.abort('cancelled');

  assert.equal(child.signal.aborted, false);

  handle.deregister();
  assert.equal(parent.childRunIds.has(childRunId), false);
  assert.equal(countActiveBackgroundChildren(parent), 0);
});

void test('nextSeq returns the incremented sequence number', () => {
  const runState = createRunState({
    runId: 'seq-run',
    runContext: makeRunContext(),
  });

  assert.equal(nextSeq(runState), 1);
  assert.equal(nextSeq(runState), 2);
  assert.equal(runState.seq, 2);
});

void test('run status helpers follow the canonical lifecycle transitions', () => {
  const runState = createRunState({
    runId: 'run-1',
    runContext: makeRunContext(),
  });

  assert.equal(runState.status, 'running');
  markRunApprovalPending(runState);
  assert.equal(runState.status, RUN_APPROVAL_PENDING_STATUS);
  markRunRunning(runState);
  completeRun(runState);
  assert.equal(runState.status, 'completed');
});

void test('run status helpers reject reopening a terminal run', () => {
  const runState = createRunState({
    runId: 'run-2',
    runContext: makeRunContext(),
  });

  completeRun(runState);

  assert.throws(
    () => markRunRunning(runState),
    /invalid run status transition: completed -> running/,
  );
});

void test('failOrCancelRun follows the signal outcome', () => {
  const failedRun = createRunState({
    runId: 'run-3',
    runContext: makeRunContext(),
  });
  failOrCancelRun(failedRun);
  assert.equal(failedRun.status, 'failed');

  const cancelledRun = createRunState({
    runId: 'run-4',
    runContext: makeRunContext(),
  });
  const controller = new AbortController();
  controller.abort();
  failOrCancelRun(cancelledRun, controller.signal);
  assert.equal(cancelledRun.status, 'cancelled');

  const directCancelledRun = createRunState({
    runId: 'run-5',
    runContext: makeRunContext(),
  });
  cancelRun(directCancelledRun);
  assert.equal(directCancelledRun.status, 'cancelled');
});

void test('settleRunAfterResult completes successful and answered runs', () => {
  const successfulRun = createRunState({
    runId: 'run-6',
    runContext: makeRunContext(),
  });
  settleRunAfterResult(successfulRun, { ok: true, finalProse: 'done' });
  assert.equal(successfulRun.status, 'completed');

  const answeredFailure = createRunState({
    runId: 'run-7',
    runContext: makeRunContext(),
  });
  settleRunAfterResult(answeredFailure, {
    ok: false,
    finalProse: 'tool limit summary',
  });
  assert.equal(answeredFailure.status, 'completed');

  const artifactOnlyRun = createRunState({
    runId: 'run-7-artifact',
    runContext: makeRunContext(),
  });
  settleRunAfterResult(artifactOnlyRun, {
    ok: false,
    finalProse: '',
    artifactCandidate: {
      renderer: 'markdown',
      payload: '# Chapter 1',
      digest: 'sha256:abc123',
    },
  });
  assert.equal(artifactOnlyRun.status, 'completed');
});

void test('settleRunAfterResult follows abort outcome for empty failures', () => {
  const failedRun = createRunState({
    runId: 'run-8',
    runContext: makeRunContext(),
  });
  settleRunAfterResult(failedRun, { ok: false, finalProse: '' });
  assert.equal(failedRun.status, 'failed');

  const cancelledRun = createRunState({
    runId: 'run-9',
    runContext: makeRunContext(),
  });
  const controller = new AbortController();
  controller.abort();
  settleRunAfterResult(
    cancelledRun,
    { ok: false, finalProse: '' },
    controller.signal,
  );
  assert.equal(cancelledRun.status, 'cancelled');
});

void test('settleRunAfterTerminalFailure supports explicit failed and cancelled outcomes', () => {
  const failedRun = createRunState({
    runId: 'run-10',
    runContext: makeRunContext(),
  });
  settleRunAfterTerminalFailure(failedRun, undefined, 'failed');
  assert.equal(failedRun.status, 'failed');

  const cancelledRun = createRunState({
    runId: 'run-11',
    runContext: makeRunContext(),
  });
  settleRunAfterTerminalFailure(cancelledRun, undefined, 'cancelled');
  assert.equal(cancelledRun.status, 'cancelled');
});
