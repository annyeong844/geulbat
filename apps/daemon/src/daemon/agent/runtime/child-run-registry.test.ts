import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';

import { createChildRunRegistry } from './child-run-registry.js';
import type { ChildRunSnapshot } from '../../subagent-runtime-contracts.js';
import { testRunId } from '../../../test-support/run-id.js';
import { TEST_CHILD_MODEL_REGISTRATION } from '../../../test-support/subagent-model-routing.js';
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
    ...TEST_CHILD_MODEL_REGISTRATION,
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

void test('child run registry preserves and clones the child model pin and routing policy', () => {
  const registry = createChildRunRegistry();
  const childRunId = testRunId('child-model-pin');

  registry.registerChildRun({
    childRunId,
    childThreadId: testThreadId(74),
    parentRunId: testRunId('parent-model-pin'),
    ownerThreadId: testThreadId(75),
    subagentType: 'explorer',
    modelPin: {
      modelId: 'gpt-5.6-luna',
      providerRunSelection: {
        providerModel: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        },
        reasoningEffort: 'xhigh',
      },
      selectionSource: 'user_fixed',
    },
    subagentModelRouting: {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
  });

  const first = registry.getChildRun(childRunId);
  assert.ok(first);
  assert.deepEqual(first.modelPin, {
    modelId: 'gpt-5.6-luna',
    providerRunSelection: {
      providerModel: {
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-luna',
      },
      reasoningEffort: 'xhigh',
    },
    selectionSource: 'user_fixed',
  });
  assert.deepEqual(first.subagentModelRouting, {
    mode: 'fixed',
    choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
  });

  first.modelPin.modelId = 'grok-4.5';
  first.modelPin.providerRunSelection.providerModel.providerId = 'grok_oauth';
  first.modelPin.providerRunSelection.providerModel.model = 'grok-4.5';
  first.modelPin.providerRunSelection.reasoningEffort = 'high';
  if (first.subagentModelRouting.mode === 'fixed') {
    first.subagentModelRouting.choice.modelId = 'gpt-5.6-sol';
    first.subagentModelRouting.choice.reasoningEffort = 'medium';
  }

  const reread = registry.getChildRun(childRunId);
  assert.equal(reread?.modelPin.modelId, 'gpt-5.6-luna');
  assert.deepEqual(reread?.subagentModelRouting, {
    mode: 'fixed',
    choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
  });
});

void test('child run registry wait resolves on revision change', async () => {
  const registry = createChildRunRegistry();
  const initial = registry.getChildRuns([]).revision;
  const waiting = registry.waitForRevisionChange(initial);

  await delay(0);
  registry.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
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
    ...TEST_CHILD_MODEL_REGISTRATION,
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

void test('child run registry retains terminal records across elapsed time', async () => {
  const registry = createChildRunRegistry();
  const childRunId = testRunId('child-retained');

  registry.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(7),
    parentRunId: testRunId('parent-retained'),
    ownerThreadId: testThreadId(8),
    subagentType: 'worker',
  });
  registry.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'ok',
  });

  await delay(30);

  assert.equal(registry.getChildRun(childRunId)?.status, 'completed');
  assert.equal(registry.getChildRun(childRunId)?.result, 'ok');
});

void test('child run registry retains every terminal record in a broad fan-out', () => {
  const registry = createChildRunRegistry();
  const ownerThreadId = testThreadId(30);
  const childRunIds = Array.from({ length: 20 }, (_, index) =>
    testRunId(`fanout-${index}`),
  );

  for (const [index, childRunId] of childRunIds.entries()) {
    registry.registerChildRun({
      ...TEST_CHILD_MODEL_REGISTRATION,
      childRunId,
      childThreadId: testThreadId(20 + index),
      parentRunId: testRunId('parent-fanout'),
      ownerThreadId,
      subagentType: 'worker',
    });
    registry.markChildTerminal({
      childRunId,
      terminalState: 'completed',
      result: childRunId,
    });
  }

  assert.deepEqual(
    childRunIds.map((childRunId) => registry.getChildRun(childRunId)?.status),
    childRunIds.map(() => 'completed'),
  );
});

void test('child run registry claims only terminal records owned by the caller', () => {
  const registry = createChildRunRegistry();
  const ownerThreadId = testThreadId(40);
  const otherOwnerThreadId = testThreadId(41);
  const terminalChildRunId = registerTerminalChild(
    registry,
    'claim-terminal',
    ownerThreadId,
    42,
  );
  const runningChildRunId = testRunId('claim-running');
  const otherOwnerChildRunId = registerTerminalChild(
    registry,
    'claim-other-owner',
    otherOwnerThreadId,
    43,
  );

  registry.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId: runningChildRunId,
    childThreadId: testThreadId(44),
    parentRunId: testRunId('parent-running'),
    ownerThreadId,
    subagentType: 'worker',
  });

  const claimed = registry.claimTerminalChildRuns({
    ownerThreadId,
    childRunIds: [
      terminalChildRunId,
      runningChildRunId,
      otherOwnerChildRunId,
      testRunId('claim-missing'),
    ],
  });

  assert.equal(claimed, 1);
  assert.equal(registry.getChildRun(terminalChildRunId), undefined);
  assert.equal(registry.getChildRun(runningChildRunId)?.status, 'running');
  assert.equal(
    registry.getChildRun(otherOwnerChildRunId)?.ownerThreadId,
    otherOwnerThreadId,
  );
});

function registerTerminalChild(
  registry: ReturnType<typeof createChildRunRegistry>,
  childName: string,
  ownerThreadId: ThreadId,
  threadSeed: number,
): RunId {
  const childRunId = testRunId(childName);
  registry.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(threadSeed),
    parentRunId: testRunId('parent-terminal'),
    ownerThreadId,
    subagentType: 'worker',
  });
  registry.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: childName,
  });
  return childRunId;
}

void test('registering an existing child id starts the next lifecycle', () => {
  const owner = testThreadId(70);
  const registry = createChildRunRegistry();
  const childRunId = registerTerminalChild(registry, 'reuse-child', owner, 71);

  registry.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(72),
    parentRunId: testRunId('parent-reuse-next'),
    ownerThreadId: owner,
    subagentType: 'worker',
  });

  const snapshot = registry.getChildRun(childRunId);
  assert.equal(snapshot?.status, 'running');
  assert.equal(snapshot?.result, null);
  assert.equal(snapshot?.childThreadId, testThreadId(72));
});
