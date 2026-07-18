import test from 'node:test';
import assert from 'node:assert/strict';
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
import { MID_RUN_STEER_ENABLED_ENV } from '../../../daemon/agent/mid-run-steer-flag.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
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

void test('handleRunInterject reports disabled while mid-run steer is gated off', () => {
  const restoreMidRunSteer = setMidRunSteerForTest(undefined);
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    handleRunInterject(
      socket,
      'interject-disabled',
      {
        runId: testRunId('interject-disabled'),
        text: 'please steer this run',
      } satisfies RunInterjectRequest,
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'interject-disabled',
      status: 503,
      code: 'bad_request',
      message: 'mid-run steer is not enabled',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreMidRunSteer();
  }
});

void test('handleRunInterject reports invalid_args for malformed text', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    handleRunInterject(
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterject reports not_found before ownership for missing runs', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const runId = testRunId('interject-missing');

  try {
    handleRunInterject(
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterject reports access_denied when socket does not own an active run', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
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
    handleRunInterject(
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterject appends to an owned active-run buffer', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
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
  getSocketState(socket).activeRunIds.add(runId);

  try {
    handleRunInterject(
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
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
    cleanupSocketState(socket, daemonContext);
    restoreMidRunSteer();
  }
});

void test('handleRunInterject reports not_found for aborted active runs', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
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
    handleRunInterject(
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterjectFlush reports disabled while mid-run steer is gated off', () => {
  const restoreMidRunSteer = setMidRunSteerForTest(undefined);
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();

  try {
    handleRunInterjectFlush(
      socket,
      'flush-disabled',
      { runId: testRunId('flush-disabled') },
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'flush-disabled',
      status: 503,
      code: 'bad_request',
      message: 'mid-run steer is not enabled',
    });
  } finally {
    cleanupSocketState(socket, daemonContext);
    restoreMidRunSteer();
  }
});

void test('handleRunInterjectFlush reports not_found for missing runs', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterjectFlush reports access_denied when socket does not own the run', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterjectFlush marks an owned queued buffer and acks flushed=true', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
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
    restoreMidRunSteer();
  }
});

void test('handleRunInterjectFlush acks flushed=false when the queue is empty', () => {
  const restoreMidRunSteer = setMidRunSteerForTest('1');
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
    restoreMidRunSteer();
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

void test('handleRunApprove resolves pending background approvals after parent run completion', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(122);
  const runId = 'run-approve-background-worker' as RunId;
  const callId = 'call-approve-background-worker';
  const approvalSessionId = getSocketState(socket).approvalSessionId;

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
    handleRunApprove(
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

function setMidRunSteerForTest(value: string | undefined): () => void {
  const previous = process.env[MID_RUN_STEER_ENABLED_ENV];
  restoreEnv(MID_RUN_STEER_ENABLED_ENV, value);
  return () => restoreEnv(MID_RUN_STEER_ENABLED_ENV, previous);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

void test('handleRunApprove rejects a pending approval when the socket does not own the run', async () => {
  const socket = createTestSocket();
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(121);
  const runId = 'run-approve-non-owner' as RunId;
  const callId = 'call-approve-non-owner';

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
    handleRunApprove(
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
    daemonContext.approvalGate.resolveApproval(
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
      message: 'grantScope must be once, run, or session',
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
