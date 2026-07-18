import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { RunInterjectRequest } from '@geulbat/protocol/run-channel';
import type { RunId } from '@geulbat/protocol/ids';

import {
  clearSentMessages,
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import {
  handleRunApprove,
  handleRunCancel,
  handleRunInterject,
  handleRunInterjectCancel,
  handleRunInterjectFlush,
} from './run-channel-control.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  createRunInterjectBuffer,
  isInterjectFlushRequested,
  pushPendingInterject,
} from '../../../daemon/sessions/active-run-interject-buffer.js';
import { createDaemonContext } from '../../../daemon/context.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

async function startApprovalCheckpoint(
  daemonContext: ReturnType<typeof createDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  runId: RunId,
): Promise<void> {
  const result = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  assert.equal(result.ok, true);
}

async function createApprovalTestDaemonContext(): Promise<
  ReturnType<typeof createDaemonContext>
> {
  return createDaemonContext({
    homeStateRoot: await mkdtemp(join(tmpdir(), 'geulbat-approval-control-')),
  });
}

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
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject: createRunInterjectBuffer(),
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
      ...makeRunContext({ threadId: ownerThreadId }),
      ownerThreadId,
      abortController: parentAbortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-30T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(childThreadId, {
      runId: childRunId,
      ...makeRunContext({ threadId: childThreadId }),
      ownerThreadId,
      abortController: childAbortController,
      interject: createRunInterjectBuffer(),
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
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject: createRunInterjectBuffer(),
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

void test('handleRunInterject reports invalid_args for malformed text', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    await handleRunInterject(
      socket,
      'interject-invalid',
      {
        runId: testRunId('interject-invalid'),
        text: '   ',
      },
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-invalid',
      status: 400,
      code: 'invalid_args',
      message: 'text is required',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject reports not_found before ownership for missing runs', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = testRunId('interject-missing');

  try {
    await handleRunInterject(
      socket,
      'interject-missing',
      {
        runId,
        text: 'please steer this missing run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-missing',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject reports access_denied when socket does not own an active run', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(131);
  const runId = testRunId('interject-unowned');
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);

  try {
    await handleRunInterject(
      socket,
      'interject-unowned',
      {
        runId,
        text: 'please steer this unowned run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-unowned',
      status: 403,
      code: 'access_denied',
      message: `socket does not own run: ${runId}`,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject durably appends to an owned active-run buffer', async (t) => {
  const socket = createTestSocket();
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-interject-control-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = testThreadId(132);
  const runId = testRunId('interject-owned');
  const interject = createRunInterjectBuffer();
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  getSocketState(socket).activeRunIds.add(runId);

  try {
    await handleRunInterject(
      socket,
      'interject-owned',
      {
        runId,
        text: '  preserve steer text  ',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'interject-owned',
      action: 'run.interject',
      ok: true,
      receivedSeq: 1,
      bufferDepth: 1,
    });
    assert.deepEqual(interject.items, [
      { receivedSeq: 1, text: '  preserve steer text  ' },
    ]);
    assert.deepEqual(
      (await daemonContext.runCheckpoints.readThread(threadId))
        ?.pendingInterjects,
      [{ receivedSeq: 1, text: '  preserve steer text  ' }],
    );
    await handleRunInterjectCancel(
      socket,
      'interject-owned-cancel',
      { runId, receivedSeq: 1 },
      daemonContext,
    );
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'interject-owned-cancel',
      action: 'run.interject.cancel',
      ok: true,
      cancelled: true,
    });
    assert.deepEqual(interject.items, []);
    assert.deepEqual(
      (await daemonContext.runCheckpoints.readThread(threadId))
        ?.pendingInterjects,
      [],
    );
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterject reports not_found for aborted active runs', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(133);
  const runId = testRunId('interject-aborted');
  const abortController = new AbortController();
  const interject = createRunInterjectBuffer();
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController,
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);
  abortController.abort();

  try {
    await handleRunInterject(
      socket,
      'interject-aborted',
      {
        runId,
        text: 'please steer this aborted run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-aborted',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
    assert.deepEqual(interject.items, []);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush reports not_found for missing runs', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = testRunId('flush-missing');

  try {
    handleRunInterjectFlush(socket, 'flush-missing', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'flush-missing',
      status: 404,
      code: 'not_found',
      message: `no active run: ${runId}`,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush reports access_denied when socket does not own the run', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(133);
  const runId = testRunId('flush-unowned');
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject: createRunInterjectBuffer(),
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);

  try {
    handleRunInterjectFlush(socket, 'flush-unowned', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'flush-unowned',
      status: 403,
      code: 'access_denied',
      message: `socket does not own run: ${runId}`,
    });
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush marks an owned queued buffer and acks flushed=true', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(134);
  const runId = testRunId('flush-owned');
  const interject = createRunInterjectBuffer();
  pushPendingInterject(interject, 'queued steer');
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunInterjectFlush(socket, 'flush-owned', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'flush-owned',
      action: 'run.interject.flush',
      ok: true,
      flushed: true,
    });
    assert.equal(isInterjectFlushRequested(interject), true);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunInterjectFlush acks flushed=false when the queue is empty', () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(135);
  const runId = testRunId('flush-empty');
  const interject = createRunInterjectBuffer();
  const startResult = daemonContext.activeRuns.tryStartRun(threadId, {
    runId,
    ...makeRunContext({ threadId }),
    ownerThreadId: threadId,
    abortController: new AbortController(),
    interject,
    startedAt: '2026-03-30T00:00:00.000Z',
  });
  assert.equal(startResult.ok, true);
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunInterjectFlush(socket, 'flush-empty', { runId }, daemonContext);

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'flush-empty',
      action: 'run.interject.flush',
      ok: true,
      flushed: false,
    });
    assert.equal(isInterjectFlushRequested(interject), false);
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove resolves pending approvals and sends run.control', async () => {
  const socket = createTestSocket();
  const daemonContext = await createApprovalTestDaemonContext();
  const threadId = testThreadId(12);
  const runId = 'run-approve-resolve' as RunId;
  const callId = 'call-approve-resolve';
  getSocketState(socket).activeRunIds.add(runId);
  await startApprovalCheckpoint(daemonContext, threadId, runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      sessionId: 'session-approve-resolve',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    await handleRunApprove(
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

void test('handleRunApprove resolves pending background approvals after parent run completion', async () => {
  const socket = createTestSocket();
  const daemonContext = await createApprovalTestDaemonContext();
  const threadId = testThreadId(122);
  const runId = 'run-approve-background-worker' as RunId;
  const callId = 'call-approve-background-worker';
  const approvalSessionId = getSocketState(socket).approvalSessionId;
  await startApprovalCheckpoint(daemonContext, threadId, runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      sessionId: approvalSessionId,
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    await handleRunApprove(
      socket,
      'approve-background-worker',
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
      requestId: 'approve-background-worker',
      action: 'run.approve',
      ok: true,
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove rejects a pending approval when the socket does not own the run', async () => {
  const socket = createTestSocket();
  const daemonContext = await createApprovalTestDaemonContext();
  const threadId = testThreadId(121);
  const runId = 'run-approve-non-owner' as RunId;
  const callId = 'call-approve-non-owner';
  await startApprovalCheckpoint(daemonContext, threadId, runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      sessionId: 'session-approve-non-owner',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    await handleRunApprove(
      socket,
      'approve-non-owner',
      {
        callId,
        runId,
        threadId,
        approved: true,
        grantScope: 'once',
      } satisfies ApprovalRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'approve-non-owner',
      status: 403,
      code: 'access_denied',
      message: `socket does not own run: ${runId}`,
    });
    await daemonContext.approvalGate.resolveApproval(
      callId,
      runId,
      threadId,
      'denied',
    );
    assert.equal(await wait, 'denied');
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove rejects invalid grant scopes', async () => {
  const socket = createTestSocket();
  const daemonContext = await createApprovalTestDaemonContext();

  try {
    await handleRunApprove(
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
      message: 'grantScope must be once, run, or session',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
  }
});

void test('handleRunApprove reports conflict when the approval was already resolved', async () => {
  const socket = createTestSocket();
  const daemonContext = await createApprovalTestDaemonContext();
  const threadId = testThreadId(13);
  const runId = 'run-approve-conflict' as RunId;
  const callId = 'call-approve-conflict';
  getSocketState(socket).activeRunIds.add(runId);
  await startApprovalCheckpoint(daemonContext, threadId, runId);

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
      sessionId: 'session-approve-conflict',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    await handleRunApprove(socket, 'approve-first', request, daemonContext);
    assert.equal(await wait, 'approved');

    clearSentMessages(socket);
    await handleRunApprove(socket, 'approve-second', request, daemonContext);

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
  const daemonContext = await createApprovalTestDaemonContext();
  const threadId = testThreadId(113);
  const runId = 'run-approve-local-gate' as RunId;
  const callId = 'call-approve-local-gate';
  getSocketState(socket).activeRunIds.add(runId);
  await startApprovalCheckpoint(daemonContext, threadId, runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      sessionId: 'session-approve-local',
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
  );

  try {
    await handleRunApprove(
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
