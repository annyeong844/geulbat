import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';

import { createChildRunRegistry } from './child-run-registry.js';
import type { ChildRunSnapshot } from '../../subagent-runtime-contracts.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

function readBrandedSnapshotIds(snapshot: ChildRunSnapshot): {
  childRunId: RunId;
  childThreadId: ThreadId;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
} {
  return {
    childRunId: snapshot.childRunId,
    childThreadId: snapshot.childThreadId,
    parentRunId: snapshot.parentRunId,
    ownerThreadId: snapshot.ownerThreadId,
  };
}

function readTerminalSnapshotResult(snapshot: ChildRunSnapshot): string | null {
  switch (snapshot.status) {
    case 'running':
    case 'approval_pending': {
      const pendingResult: null = snapshot.result;
      const pendingCompletedAt: null = snapshot.completedAt;
      return pendingResult ?? pendingCompletedAt;
    }
    case 'completed':
    case 'failed':
    case 'cancelled': {
      const terminalResult: string = snapshot.result;
      const terminalCompletedAt: string = snapshot.completedAt;
      return `${terminalCompletedAt}:${terminalResult}`;
    }
  }
}

void test('child run registry tracks launch, approval pending, and terminal state', () => {
  const registry = createChildRunRegistry();

  registry.registerChildRun({
    childRunId: testRunId('child-1'),
    childThreadId: testThreadId(1),
    parentRunId: testRunId('parent-1'),
    ownerThreadId: testThreadId(2),
    subagentType: 'worker',
  });
  registry.markChildApprovalPending(testRunId('child-1'));
  registry.markChildTerminal({
    childRunId: testRunId('child-1'),
    terminalState: 'failed',
    result: 'child failed',
    reason: 'child_error',
  });

  const snapshot = registry.getChildRun(testRunId('child-1'));
  assert.equal(snapshot?.status, 'failed');
  assert.equal(snapshot?.result, 'child failed');
  assert.equal(snapshot?.reason, 'child_error');
  assert.equal(snapshot?.parentRunId, testRunId('parent-1'));
  if (snapshot) {
    assert.deepEqual(readBrandedSnapshotIds(snapshot), {
      childRunId: testRunId('child-1'),
      childThreadId: testThreadId(1),
      parentRunId: testRunId('parent-1'),
      ownerThreadId: testThreadId(2),
    });
  }
  const terminalResult = snapshot ? readTerminalSnapshotResult(snapshot) : null;
  assert.equal(terminalResult?.includes('child failed'), true);
});

void test('child run registry wait resolves on revision change', async () => {
  const registry = createChildRunRegistry();
  const initial = registry.getChildRuns([]).revision;
  const waiting = registry.waitForRevisionChange(initial);

  await delay(0);
  registry.registerChildRun({
    childRunId: testRunId('child-2'),
    childThreadId: testThreadId(3),
    parentRunId: testRunId('parent-2'),
    ownerThreadId: testThreadId(4),
    subagentType: 'explorer',
  });

  const nextRevision = await waiting;
  assert.equal(nextRevision > initial, true);
});

void test('child run registry does not bump revision when state does not change', () => {
  const registry = createChildRunRegistry();
  const childRunId = testRunId('child-3');

  registry.registerChildRun({
    childRunId,
    childThreadId: testThreadId(5),
    parentRunId: testRunId('parent-3'),
    ownerThreadId: testThreadId(6),
    subagentType: 'worker',
  });
  const revisionAfterRegister = registry.getChildRuns([childRunId]).revision;

  registry.markChildRunning(childRunId);
  assert.equal(
    registry.getChildRuns([childRunId]).revision,
    revisionAfterRegister,
  );

  registry.markChildApprovalPending(childRunId);
  const revisionAfterApprovalPending = registry.getChildRuns([
    childRunId,
  ]).revision;
  registry.markChildApprovalPending(childRunId);
  assert.equal(
    registry.getChildRuns([childRunId]).revision,
    revisionAfterApprovalPending,
  );
});

void test('child run registry collects terminal records after retention TTL', async () => {
  const registry = createChildRunRegistry({
    retentionTtlMs: 10,
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const childRunId = testRunId('child-ttl');
    registry.registerChildRun({
      childRunId,
      childThreadId: testThreadId(7),
      parentRunId: testRunId('parent-ttl'),
      ownerThreadId: testThreadId(8),
      subagentType: 'worker',
    });
    registry.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: 'ok',
    });

    assert.equal(registry.getChildRun(childRunId)?.status, 'completed');
    await delay(30);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(registry.getChildRun(testRunId('child-ttl')), undefined);
  assert.equal(warnings.length, 1);
});

void test('child run registry evicts the oldest terminal record when the retention budget is exceeded', () => {
  const registry = createChildRunRegistry({
    retentionTtlMs: 5 * 60 * 1000,
    maxRetainedTerminalRuns: 2,
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const childRunIds = [
      testRunId('child-a'),
      testRunId('child-b'),
      testRunId('child-c'),
    ];
    for (const [index, childRunId] of childRunIds.entries()) {
      registry.registerChildRun({
        childRunId,
        childThreadId: testThreadId(20 + index),
        parentRunId: testRunId('parent-budget'),
        ownerThreadId: testThreadId(30),
        subagentType: 'worker',
      });
      registry.markChildTerminal({
        childRunId,
        terminalState: 'completed',
        result: childRunId,
      });
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(registry.getChildRun(testRunId('child-a')), undefined);
  assert.equal(registry.getChildRun(testRunId('child-b'))?.status, 'completed');
  assert.equal(registry.getChildRun(testRunId('child-c'))?.status, 'completed');
  assert.equal(warnings.length, 1);
});
