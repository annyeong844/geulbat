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
      async recordApprovalPending({ callId, approvalClass }) {
        const existing = approvals.get(callId);
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
        approvals.set(callId, approval);
        return { ok: true, approval };
      },
      async recordApprovalDecision({ callId, decision, grantScope }) {
        const existing = approvals.get(callId);
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
        approvals.set(callId, approval);
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
      sessionId: 'session-1',
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
      sessionId: 'session-2',
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
    sessionId: 'session-3',
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

void test('clearApprovalSessionRuntime aborts pending waiters for the same session', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(5);
  const wait = gate.waitForApproval(
    'call-4',
    'run-4',
    threadId,
    {
      runId: 'run-4',
      sessionId: 'session-4',
      approvalClass: toApprovalClass('write_file'),
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1000),
  );

  gate.clearApprovalSessionRuntime('session-4');

  assert.equal(await wait, 'aborted');
  assert.equal(
    await gate.resolveApproval('call-4', 'run-4', threadId, 'approved'),
    'not_found',
  );
});

void test('clearApprovalSessionRuntime clears resolved approvals for that session only', async () => {
  const gate = createTestApprovalGate();
  const threadId = testThreadId(7);
  const firstWait = gate.waitForApproval(
    'call-session-a',
    'run-session-a',
    threadId,
    {
      runId: 'run-session-a',
      sessionId: 'session-a',
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
      sessionId: 'session-b',
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

  gate.clearApprovalSessionRuntime('session-a');

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
    'already_resolved',
  );
});

void test('clearApprovalSessionGrants clears grants without aborting pending approvals', async () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createTestApprovalGate(approvalGrants);
  const threadId = testThreadId(6);
  const approvalContext = {
    runId: 'run-5',
    sessionId: 'session-5',
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

  gate.clearApprovalSessionGrants('session-5');

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

void test('rebindApprovalSessionRuntime keeps a pending decision on the replacement session', async () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createTestApprovalGate(approvalGrants);
  const threadId = testThreadId(8);
  const previousContext = {
    runId: 'run-rebind-pending',
    sessionId: 'session-before-reconnect',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const nextContext = {
    ...previousContext,
    sessionId: 'session-after-reconnect',
  };
  const wait = gate.waitForApproval(
    'call-rebind-pending',
    previousContext.runId,
    threadId,
    previousContext,
    AbortSignal.timeout(1_000),
  );

  gate.rebindApprovalSessionRuntime(
    previousContext.sessionId,
    nextContext.sessionId,
  );

  assert.equal(
    gate.hasPendingApprovalForSession(
      'call-rebind-pending',
      previousContext.runId,
      threadId,
      previousContext.sessionId,
    ),
    false,
  );
  assert.equal(
    gate.hasPendingApprovalForSession(
      'call-rebind-pending',
      previousContext.runId,
      threadId,
      nextContext.sessionId,
    ),
    true,
  );
  assert.equal(
    await gate.resolveApproval(
      'call-rebind-pending',
      previousContext.runId,
      threadId,
      'approved',
      'run',
    ),
    'resolved',
  );
  assert.equal(await wait, 'approved');
  assert.equal(approvalGrants.hasApprovalGrant(previousContext), false);
  assert.equal(approvalGrants.hasApprovalGrant(nextContext), true);
});

void test('rebindApprovalSessionRuntime preserves run grants but not session grants', () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createTestApprovalGate(approvalGrants);
  const runGrant = {
    runId: 'run-rebind-grant',
    sessionId: 'session-grant-before',
    approvalClass: toApprovalClass('write_file'),
    sideEffectLevel: 'write' as const,
    permissionMode: 'basic' as const,
  };
  const sessionGrant = {
    ...runGrant,
    approvalClass: toApprovalClass('execute_code'),
  };
  approvalGrants.registerApprovalGrant(runGrant, 'run');
  approvalGrants.registerApprovalGrant(sessionGrant, 'session');

  gate.rebindApprovalSessionRuntime(runGrant.sessionId, 'session-grant-after');

  assert.equal(
    approvalGrants.hasApprovalGrant({
      ...runGrant,
      sessionId: 'session-grant-after',
    }),
    true,
  );
  assert.equal(
    approvalGrants.hasApprovalGrant({
      ...sessionGrant,
      sessionId: 'session-grant-after',
    }),
    false,
  );
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
    sessionId: 'session-before-approval-restart',
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
    { ...approvalContext, sessionId: 'session-after-approval-restart' },
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
    sessionId: 'session-after-decided-restart',
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
