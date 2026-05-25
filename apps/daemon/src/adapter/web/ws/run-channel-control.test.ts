import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { RunId } from '@geulbat/protocol/ids';

import {
  clearSentMessages,
  createTestSocket,
  readLastSentMessage,
} from './run-channel-test-support.js';
import { handleRunApprove, handleRunCancel } from './run-channel-control.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { makeRunWorkspaceContext } from '../../../test-support/run-workspace-context.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('handleRunCancel reports bad_request when runId is missing', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    handleRunCancel(
      socket,
      'cancel-missing',
      {
        runId: '' as unknown as RunId,
      } satisfies CancelRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-missing',
      status: 400,
      code: 'bad_request',
      message: 'runId is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel aborts an owned active run and sends run.control', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(11);
  const runId = 'run-cancel-owned' as RunId;
  const abortController = new AbortController();

  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunWorkspaceContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunCancel(
      socket,
      'cancel-owned',
      { runId } satisfies CancelRequest,
      daemonContext,
    );

    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-owned',
      action: 'run.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel aborts the owned run thread tree, including child runs', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(211);
  const childThreadId = testThreadId(212);
  const parentRunId = 'run-cancel-parent' as RunId;
  const childRunId = 'run-cancel-child' as RunId;
  const parentAbortController = new AbortController();
  const childAbortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(ownerThreadId, {
      runId: parentRunId,
      ...makeRunWorkspaceContext({ threadId: ownerThreadId }),
      ownerThreadId,
      abortController: parentAbortController,
      startedAt: '2026-03-30T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(childThreadId, {
      runId: childRunId,
      ...makeRunWorkspaceContext({ threadId: childThreadId }),
      ownerThreadId,
      abortController: childAbortController,
      startedAt: '2026-03-30T00:00:01.000Z',
      parentRunId,
    }),
    { ok: true },
  );
  getSocketState(socket).activeRunIds.add(parentRunId);

  try {
    handleRunCancel(
      socket,
      'cancel-tree',
      { runId: parentRunId } satisfies CancelRequest,
      daemonContext,
    );

    assert.equal(parentAbortController.signal.aborted, true);
    assert.equal(childAbortController.signal.aborted, true);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-tree',
      action: 'run.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(ownerThreadId, parentRunId);
    daemonContext.activeRuns.finishRun(childThreadId, childRunId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel reports not_found when the socket owns a missing run', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = 'run-cancel-missing' as RunId;
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunCancel(
      socket,
      'cancel-not-found',
      {
        runId,
      } satisfies CancelRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'cancel-not-found',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunCancel can use an injected active-run store', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(111);
  const runId = 'run-cancel-local-store' as RunId;
  const abortController = new AbortController();

  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunWorkspaceContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunCancel(
      socket,
      'cancel-local-store',
      { runId } satisfies CancelRequest,
      daemonContext,
    );

    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'cancel-local-store',
      action: 'run.cancel',
      ok: true,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove resolves pending approvals and sends run.control', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(12);
  const runId = 'run-approve-resolve' as RunId;
  const callId = 'call-approve-resolve';
  getSocketState(socket).activeRunIds.add(runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      threadId,
      sessionId: 'session-approve-resolve',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    handleRunApprove(
      socket,
      'approve-resolve',
      {
        callId,
        runId,
        threadId,
        approved: true,
        grantScope: 'once',
      } satisfies ApprovalRequest,
      daemonContext,
    );

    assert.equal(await wait, 'approved');
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'approve-resolve',
      action: 'run.approve',
      ok: true,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove can resolve a retained pending approval after socket reconnect', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(121);
  const runId = 'run-approve-reconnect' as RunId;
  const callId = 'call-approve-reconnect';

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      threadId,
      sessionId: 'session-approve-reconnect',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    handleRunApprove(
      socket,
      'approve-reconnect',
      {
        callId,
        runId,
        threadId,
        approved: true,
        grantScope: 'once',
      } satisfies ApprovalRequest,
      daemonContext,
    );

    assert.equal(await wait, 'approved');
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'approve-reconnect',
      action: 'run.approve',
      ok: true,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove rejects invalid grant scopes', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    handleRunApprove(
      socket,
      'approve-invalid-scope',
      {
        callId: 'call-invalid-scope',
        runId: 'run-invalid-scope' as RunId,
        threadId: testThreadId(120),
        approved: true,
        grantScope: 'forever' as ApprovalRequest['grantScope'],
      },
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'approve-invalid-scope',
      status: 400,
      code: 'bad_request',
      message: 'grantScope is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove reports conflict when the approval was already resolved', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(13);
  const runId = 'run-approve-conflict' as RunId;
  const callId = 'call-approve-conflict';
  getSocketState(socket).activeRunIds.add(runId);

  const request = {
    callId,
    runId,
    threadId,
    approved: true,
    grantScope: 'once',
  } satisfies ApprovalRequest;

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      threadId,
      sessionId: 'session-approve-conflict',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    handleRunApprove(socket, 'approve-first', request, daemonContext);
    assert.equal(await wait, 'approved');

    clearSentMessages(socket);
    handleRunApprove(socket, 'approve-second', request, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'approve-second',
      status: 409,
      code: 'conflict',
      message: `approval already processed: ${callId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove can use an injected approval gate', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(113);
  const runId = 'run-approve-local-gate' as RunId;
  const callId = 'call-approve-local-gate';
  getSocketState(socket).activeRunIds.add(runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      threadId,
      sessionId: 'session-approve-local',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    handleRunApprove(
      socket,
      'approve-local-gate',
      {
        callId,
        runId,
        threadId,
        approved: true,
        grantScope: 'once',
      } satisfies ApprovalRequest,
      daemonContext,
    );

    assert.equal(await wait, 'approved');
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'approve-local-gate',
      action: 'run.approve',
      ok: true,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});
