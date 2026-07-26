import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createApprovalGrantStore } from '../../tools/approval-grants.js';
import {
  createRunCheckpointStore,
  type RunCheckpointApproval,
} from '../../sessions/run-checkpoint-store.js';
import { createApprovalGate } from './approval-gate.js';

function createTestApprovalGate(
  approvalGrants = createApprovalGrantStore(),
): ReturnType<typeof createApprovalGate> {
  const approvals = new Map<string, RunCheckpointApproval>();
  return createApprovalGate({
    approvalGrants,
    runCheckpoints: {
      async recordApprovalPending({ callId, runId, threadId, approvalClass }) {
        const identityKey = JSON.stringify([callId, runId, threadId]);
        const existing = approvals.get(identityKey);
        if (existing !== undefined) {
          return existing.approvalClass === approvalClass
            ? { ok: true, approval: existing }
            : { ok: false, code: 'approval_conflict' };
        }
        const approval: RunCheckpointApproval = {
          status: 'pending',
          callId,
          approvalClass,
        };
        approvals.set(identityKey, approval);
        return { ok: true, approval };
      },
      async recordApprovalDecision({
        callId,
        runId,
        threadId,
        decision,
        grantScope,
      }) {
        const identityKey = JSON.stringify([callId, runId, threadId]);
        const existing = approvals.get(identityKey);
        if (existing === undefined) {
          return { ok: false, code: 'approval_not_pending' };
        }
        if (existing.status === 'decided') {
          return existing.decision === decision &&
            existing.grantScope === grantScope
            ? { ok: true, approval: existing }
            : { ok: false, code: 'approval_conflict' };
        }
        const approval: RunCheckpointApproval = {
          ...existing,
          status: 'decided',
          decision,
          grantScope,
        };
        approvals.set(identityKey, approval);
        return { ok: true, approval };
      },
    },
  });
}

void test('resolveApproval requires matching runId and threadId', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(1);
  const otherThreadId = testThreadId(2);
  const wait = gate.waitForApproval(
    'call-1',
    'run-1',
    threadId,
    {
      runId: 'run-1',
      computerSessionId: 'session-1',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1000),
  );

  assert.equal(
    await gate.resolveApproval('call-1', 'run-x', threadId, 'approved'),
    'not_found',
  );
  assert.equal(
    await gate.resolveApproval('call-1', 'run-1', otherThreadId, 'approved'),
    'not_found',
  );
  assert.equal(
    await gate.resolveApproval('call-1', 'run-1', threadId, 'approved'),
    'resolved',
  );

  await assert.doesNotReject(wait);
});

void test('the same callId in different runs retains and resolves both approval waiters', async () => {
  const gate = createTestApprovalGate();
  const callId = 'shared-call-id';
  const firstThreadId = testThreadId(14);
  const secondThreadId = testThreadId(15);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstContext = {
    runId: 'run-shared-call-first',
    computerSessionId: 'session-shared-call-first',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const secondContext = {
    runId: 'run-shared-call-second',
    computerSessionId: 'session-shared-call-second',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const firstWait = gate.waitForApproval(
    callId,
    firstContext.runId,
    firstThreadId,
    firstContext,
    firstController.signal,
  );
  const secondWait = gate.waitForApproval(
    callId,
    secondContext.runId,
    secondThreadId,
    secondContext,
    secondController.signal,
  );

  try {
    assert.equal(
      gate.hasPendingApprovalEntry(callId, firstContext.runId, firstThreadId),
      true,
    );
    assert.equal(
      gate.hasPendingApprovalEntry(callId, secondContext.runId, secondThreadId),
      true,
    );
    assert.equal(
      gate.hasApprovalDecisionAuthority(
        callId,
        firstContext.runId,
        firstThreadId,
        firstContext.computerSessionId,
      ),
      true,
    );
    assert.equal(
      gate.hasApprovalDecisionAuthority(
        callId,
        firstContext.runId,
        firstThreadId,
        secondContext.computerSessionId,
      ),
      false,
    );

    assert.equal(
      await gate.resolveApproval(
        callId,
        firstContext.runId,
        firstThreadId,
        'denied',
      ),
      'resolved',
    );
    assert.equal(
      await gate.resolveApproval(
        callId,
        secondContext.runId,
        secondThreadId,
        'approved',
      ),
      'resolved',
    );
    assert.deepEqual(await Promise.all([firstWait, secondWait]), [
      'denied',
      'approved',
    ]);
    assert.equal(
      await gate.resolveApproval(
        callId,
        firstContext.runId,
        firstThreadId,
        'denied',
      ),
      'resolved',
    );
    assert.equal(
      await gate.resolveApproval(
        callId,
        secondContext.runId,
        secondThreadId,
        'approved',
      ),
      'resolved',
    );
  } finally {
    firstController.abort();
    secondController.abort();
    await Promise.allSettled([firstWait, secondWait]);
  }
});

void test('resolveApproval accepts an exact retry but rejects a divergent decision', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(13);
  const runId = 'run-approval-retry';
  const wait = gate.waitForApproval(
    'call-approval-retry',
    runId,
    threadId,
    {
      runId,
      computerSessionId: 'session-approval-retry',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  const [initialResult, retryResult] = await Promise.all([
    gate.resolveApproval(
      'call-approval-retry',
      runId,
      threadId,
      'approved',
      'run',
      'full_access',
    ),
    gate.resolveApproval(
      'call-approval-retry',
      runId,
      threadId,
      'approved',
      'run',
      'full_access',
    ),
  ]);

  assert.deepEqual([initialResult, retryResult], ['resolved', 'resolved']);
  assert.equal(await wait, 'approved');
  assert.equal(
    await gate.resolveApproval(
      'call-approval-retry',
      runId,
      threadId,
      'approved',
      'run',
      'basic',
    ),
    'already_resolved',
  );
  assert.equal(
    await gate.resolveApproval(
      'call-approval-retry',
      runId,
      threadId,
      'approved',
      'session',
    ),
    'already_resolved',
  );
  assert.equal(
    await gate.resolveApproval(
      'call-approval-retry',
      runId,
      threadId,
      'denied',
      'once',
    ),
    'already_resolved',
  );
});

void test('resolveApproval returns already_resolved after abort settles the waiter', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(3);
  const controller = new AbortController();
  const wait = gate.waitForApproval(
    'call-2',
    'run-2',
    threadId,
    {
      runId: 'run-2',
      computerSessionId: 'session-2',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    controller.signal,
  );

  controller.abort();

  assert.equal(await wait, 'aborted');
  assert.equal(
    await gate.resolveApproval('call-2', 'run-2', threadId, 'approved'),
    'already_resolved',
  );
});

void test('resolveApproval registers reusable grants when scope exceeds once', async () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createTestApprovalGate(approvalGrants);
  const threadId = testThreadId(4);
  const approvalContext = {
    runId: 'run-3',
    computerSessionId: 'session-3',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const wait = gate.waitForApproval(
    'call-3',
    approvalContext.runId,
    threadId,
    approvalContext,
    AbortSignal.timeout(1000),
  );

  assert.equal(
    await gate.resolveApproval(
      'call-3',
      approvalContext.runId,
      threadId,
      'approved',
      'run',
    ),
    'resolved',
  );
  await assert.doesNotReject(wait);
  assert.equal(approvalGrants.hasApprovalGrant(approvalContext), true);
});

void test('clearComputerSessionRuntime aborts pending waiters for the same session', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(5);
  const wait = gate.waitForApproval(
    'call-4',
    'run-4',
    threadId,
    {
      runId: 'run-4',
      computerSessionId: 'session-4',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1000),
  );

  gate.clearComputerSessionRuntime('session-4');

  assert.equal(await wait, 'aborted');
  assert.equal(
    await gate.resolveApproval('call-4', 'run-4', threadId, 'approved'),
    'not_found',
  );
});

void test('clearComputerSessionRuntime clears resolved approvals for that session only', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(7);
  const firstWait = gate.waitForApproval(
    'call-session-a',
    'run-session-a',
    threadId,
    {
      runId: 'run-session-a',
      computerSessionId: 'session-a',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );
  const secondWait = gate.waitForApproval(
    'call-session-b',
    'run-session-b',
    threadId,
    {
      runId: 'run-session-b',
      computerSessionId: 'session-b',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  assert.equal(
    await gate.resolveApproval(
      'call-session-a',
      'run-session-a',
      threadId,
      'denied',
    ),
    'resolved',
  );
  assert.equal(
    await gate.resolveApproval(
      'call-session-b',
      'run-session-b',
      threadId,
      'denied',
    ),
    'resolved',
  );
  assert.equal(await firstWait, 'denied');
  assert.equal(await secondWait, 'denied');

  gate.clearComputerSessionRuntime('session-a');

  assert.equal(
    await gate.resolveApproval(
      'call-session-a',
      'run-session-a',
      threadId,
      'denied',
    ),
    'not_found',
  );
  assert.equal(
    await gate.resolveApproval(
      'call-session-b',
      'run-session-b',
      threadId,
      'denied',
    ),
    'resolved',
  );
});

void test('clearComputerSessionGrants clears grants without aborting pending approvals', async () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createTestApprovalGate(approvalGrants);
  const threadId = testThreadId(6);
  const approvalContext = {
    runId: 'run-5',
    computerSessionId: 'session-5',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const wait = gate.waitForApproval(
    'call-5',
    approvalContext.runId,
    threadId,
    approvalContext,
    AbortSignal.timeout(1_000),
  );
  approvalGrants.registerApprovalGrant(approvalContext, 'session');

  assert.equal(approvalGrants.hasApprovalGrant(approvalContext), true);
  assert.equal(
    gate.hasPendingApprovalEntry('call-5', approvalContext.runId, threadId),
    true,
  );

  gate.clearComputerSessionGrants('session-5');

  assert.equal(approvalGrants.hasApprovalGrant(approvalContext), false);
  assert.equal(
    gate.hasPendingApprovalEntry('call-5', approvalContext.runId, threadId),
    true,
  );
  assert.equal(
    await gate.resolveApproval(
      'call-5',
      approvalContext.runId,
      threadId,
      'approved',
    ),
    'resolved',
  );
  assert.equal(await wait, 'approved');
});

void test('a pending approval is restored from the durable checkpoint after gate recreation', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-gate-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const runId = testRunId('approval-pending-restart');
  const threadId = testThreadId(9);
  await runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  const beforeRestart = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
    runCheckpoints,
  });
  const beforeController = new AbortController();
  let observePendingBeforeRestart: () => void = () => undefined;
  const pendingBeforeRestart = new Promise<void>((resolve) => {
    observePendingBeforeRestart = resolve;
  });
  const approvalContext = {
    runId,
    computerSessionId: 'session-before-approval-restart',
    approvalClass: toApprovalClass('write_file:computer'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const oldWait = beforeRestart.waitForApproval(
    'call-approval-restart',
    runId,
    threadId,
    approvalContext,
    beforeController.signal,
    observePendingBeforeRestart,
  );
  await pendingBeforeRestart;
  assert.deepEqual((await runCheckpoints.readThread(threadId))?.approvals, [
    {
      status: 'pending',
      callId: 'call-approval-restart',
      approvalClass: approvalContext.approvalClass,
    },
  ]);
  beforeController.abort();
  assert.equal(await oldWait, 'aborted');

  const afterRestart = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
    runCheckpoints: createRunCheckpointStore({ stateRoot }),
  });
  let observeRestoredPending: () => void = () => undefined;
  const restoredPending = new Promise<void>((resolve) => {
    observeRestoredPending = resolve;
  });
  const restoredWait = afterRestart.waitForApproval(
    'call-approval-restart',
    runId,
    threadId,
    { ...approvalContext, computerSessionId: 'session-after-approval-restart' },
    AbortSignal.timeout(1_000),
    observeRestoredPending,
  );
  await restoredPending;
  assert.equal(
    await afterRestart.resolveApproval(
      'call-approval-restart',
      runId,
      threadId,
      'approved',
      'once',
    ),
    'resolved',
  );
  assert.deepEqual(
    (await runCheckpoints.readThread(threadId))?.approvals.at(-1),
    {
      status: 'decided',
      callId: 'call-approval-restart',
      approvalClass: approvalContext.approvalClass,
      decision: 'approved',
      grantScope: 'once',
    },
  );
  assert.equal(await restoredWait, 'approved');
});

void test('a durable decision resumes without another approval event and restores a run grant', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-gate-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const runId = testRunId('approval-decided-restart');
  const threadId = testThreadId(10);
  const approvalClass = toApprovalClass('write_file:computer');
  await runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  await runCheckpoints.recordApprovalPending({
    threadId,
    runId,
    callId: 'call-approved-before-restart',
    approvalClass,
  });
  await runCheckpoints.recordApprovalDecision({
    threadId,
    runId,
    callId: 'call-approved-before-restart',
    decision: 'approved',
    grantScope: 'run',
  });

  const approvalGrants = createApprovalGrantStore();
  const gate = createApprovalGate({ approvalGrants, runCheckpoints });
  const approvalContext = {
    runId,
    computerSessionId: 'session-after-decided-restart',
    approvalClass,
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  let emittedPending = false;
  assert.equal(
    await gate.waitForApproval(
      'call-approved-before-restart',
      runId,
      threadId,
      approvalContext,
      AbortSignal.timeout(1_000),
      () => {
        emittedPending = true;
      },
    ),
    'approved',
  );
  assert.equal(emittedPending, false);
  assert.equal(approvalGrants.hasApprovalGrant(approvalContext), true);
});
