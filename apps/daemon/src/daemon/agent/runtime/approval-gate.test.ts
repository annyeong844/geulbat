import test from 'node:test';
import assert from 'node:assert/strict';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createApprovalGrantStore } from '../../tools/approval-grants.js';
import { createApprovalGate } from './approval-gate.js';

void test('resolveApproval requires matching runId and threadId', async () => {
  const gate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });
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
    gate.resolveApproval('call-1', 'run-x', threadId, 'approved'),
    'not_found',
  );
  assert.equal(
    gate.resolveApproval('call-1', 'run-1', otherThreadId, 'approved'),
    'not_found',
  );
  assert.equal(
    gate.resolveApproval('call-1', 'run-1', threadId, 'approved'),
    'resolved',
  );

  await assert.doesNotReject(wait);
});

void test('resolveApproval returns already_resolved after abort settles the waiter', async () => {
  const gate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });
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
    gate.resolveApproval('call-2', 'run-2', threadId, 'approved'),
    'already_resolved',
  );
});

void test('resolveApproval registers reusable grants when scope exceeds once', async () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createApprovalGate({ approvalGrants });
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
    gate.resolveApproval(
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
  const gate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });
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
    gate.resolveApproval('call-4', 'run-4', threadId, 'approved'),
    'not_found',
  );
});

void test('clearApprovalSessionRuntime clears resolved approvals for that session only', async () => {
  const gate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });
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
    gate.resolveApproval('call-session-a', 'run-session-a', threadId, 'denied'),
    'resolved',
  );
  assert.equal(
    gate.resolveApproval('call-session-b', 'run-session-b', threadId, 'denied'),
    'resolved',
  );
  assert.equal(await firstWait, 'denied');
  assert.equal(await secondWait, 'denied');

  gate.clearApprovalSessionRuntime('session-a');

  assert.equal(
    gate.resolveApproval('call-session-a', 'run-session-a', threadId, 'denied'),
    'not_found',
  );
  assert.equal(
    gate.resolveApproval('call-session-b', 'run-session-b', threadId, 'denied'),
    'already_resolved',
  );
});

void test('clearApprovalSessionGrants clears grants without aborting pending approvals', async () => {
  const approvalGrants = createApprovalGrantStore();
  const gate = createApprovalGate({ approvalGrants });
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
    gate.resolveApproval('call-5', approvalContext.runId, threadId, 'approved'),
    'resolved',
  );
  assert.equal(await wait, 'approved');
});
