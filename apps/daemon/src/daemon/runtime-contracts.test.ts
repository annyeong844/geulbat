import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunId } from '@geulbat/protocol/ids';

import {
  isChildRunState,
  isRootRunState,
  RUN_APPROVAL_PENDING_STATUS,
  RUN_RUNNING_STATUS,
  type ChildToolRunState,
  type RootToolRunState,
  type RunStatus,
  type ToolRunState,
} from './runtime-contracts.js';
import { testRunId } from '../test-support/run-id.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _ChildToolRunStateRequiresParentRunId = Expect<
  Equal<ChildToolRunState['parentRunId'], RunId>
>;
type _RootToolRunStateDoesNotExposeParentRunId = Expect<
  Equal<RootToolRunState['parentRunId'], undefined>
>;
type _RunStatusIncludesApprovalPendingVocabulary = Expect<
  Equal<Extract<RunStatus, 'approval_pending'>, 'approval_pending'>
>;
type _RunStatusDoesNotExposeAwaitingApprovalVocabulary = Expect<
  Equal<Extract<RunStatus, 'awaiting_approval'>, never>
>;

function makeToolRunState(args: {
  runId: RunId;
  parentRunId?: RunId;
}): ToolRunState {
  return {
    runId: args.runId,
    seq: 0,
    abortController: new AbortController(),
    status: 'running',
    createdAt: '2026-05-09T00:00:00.000Z',
    childRunIds: new Set<RunId>(),
    backgroundChildRunIds: new Set<RunId>(),
    backgroundChildLaunchReservationIds: new Set<string>(),
    ...(args.parentRunId !== undefined
      ? { parentRunId: args.parentRunId }
      : {}),
  };
}

void test('RunStatus active vocabulary uses approval_pending consistently', () => {
  assert.equal(RUN_RUNNING_STATUS, 'running');
  assert.equal(RUN_APPROVAL_PENDING_STATUS, 'approval_pending');
});

void test('ToolRunState guards classify root and child states', () => {
  const root = makeToolRunState({ runId: testRunId('root') });
  const child = makeToolRunState({
    runId: testRunId('child'),
    parentRunId: testRunId('parent'),
  });

  assert.equal(isRootRunState(root), true);
  assert.equal(isChildRunState(root), false);
  assert.equal(isRootRunState(child), false);
  assert.equal(isChildRunState(child), true);
});

void test('ToolRunState guards narrow parentRunId access', () => {
  const parentRunId = testRunId('parent-narrow');
  const child = makeToolRunState({
    runId: testRunId('child-narrow'),
    parentRunId,
  });

  assert.equal(isChildRunState(child), true);
  if (isChildRunState(child)) {
    const narrowedParentRunId: RunId = child.parentRunId;
    assert.equal(narrowedParentRunId, parentRunId);
  }
});
