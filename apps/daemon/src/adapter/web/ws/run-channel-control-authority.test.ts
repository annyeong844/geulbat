import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalRequest,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { RunId } from '@geulbat/protocol/ids';

import {
  clearSentMessages,
  createTestSocket,
  readLastSentMessage,
} from '../../../test-support/run-channel-test-support.js';
import {
  handleRunApprove,
  handleRunProviderRequestRecovery,
} from './run-channel-control.js';
import {
  cleanupSocketState,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { createDaemonContext } from '../../../daemon/context.js';
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

void test('provider outcome-unknown recovery binds the authenticated actor and returns its disposition', async (t) => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-provider-recovery-control-'),
  );
  t.after(
    async () => await rm(homeStateRoot, { recursive: true, force: true }),
  );
  const socket = createTestSocket();
  const daemonContext = createDaemonContext({ homeStateRoot });
  const threadId = testThreadId(901);
  let observed:
    | {
        providerSessionId: string;
        authorizedByComputerSessionId: string;
        acknowledgePossibleDuplicateProviderWork: true;
      }
    | undefined;
  daemonContext.provider.durableRequestRecovery = {
    recoverOutcomeUnknown: async (input) => {
      observed = input;
      return { ok: true, disposition: 'abandoned' };
    },
  };

  try {
    await handleRunProviderRequestRecovery(
      socket,
      'recover-provider-request',
      {
        threadId,
        acknowledgePossibleDuplicateProviderWork: true,
      },
      daemonContext,
      'computer-authenticated-recovery',
    );

    assert.deepEqual(observed, {
      providerSessionId: threadId,
      authorizedByComputerSessionId: 'computer-authenticated-recovery',
      acknowledgePossibleDuplicateProviderWork: true,
    });
    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.control',
      requestId: 'recover-provider-request',
      action: 'run.provider_request.recover',
      ok: true,
      disposition: 'abandoned',
    });
  } finally {
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
  let effectivePermissionMode: PermissionMode = 'basic';

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      computerSessionId: getSocketState(socket).computerSessionId,
      approvalClass: 'write_file',
      sideEffectLevel: 'write',
      permissionMode: 'basic',
    },
    AbortSignal.timeout(1_000),
    undefined,
    (permissionMode) => {
      effectivePermissionMode = permissionMode;
    },
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
        permissionMode: 'full_access',
      } satisfies ApprovalRequest,
      daemonContext,
    );

    assert.equal(await wait, 'approved');
    assert.equal(effectivePermissionMode, 'full_access');
    assert.equal(
      (await daemonContext.runCheckpoints.readThread(threadId))?.request
        .permissionMode,
      'full_access',
    );
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
  const computerSessionId = getSocketState(socket).computerSessionId;
  await startApprovalCheckpoint(daemonContext, threadId, runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      computerSessionId: computerSessionId,
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

void test('handleRunApprove rejects a different computer session even when it owns the run', async () => {
  const socket = createTestSocket();
  const daemonContext = await createApprovalTestDaemonContext();
  const threadId = testThreadId(121);
  const runId = 'run-approve-non-owner' as RunId;
  const callId = 'call-approve-non-owner';
  getSocketState(socket).activeRunIds.add(runId);
  await startApprovalCheckpoint(daemonContext, threadId, runId);

  const wait = daemonContext.approvalGate.waitForApproval(
    callId,
    runId,
    threadId,
    {
      runId,
      computerSessionId: 'different-computer-session',
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
      message: `computer session does not own approval: ${callId}`,
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

void test('handleRunApprove acknowledges an exact retry and rejects a divergent decision', async () => {
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
      computerSessionId: getSocketState(socket).computerSessionId,
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
      type: 'run.control',
      requestId: 'approve-second',
      action: 'run.approve',
      ok: true,
    });

    clearSentMessages(socket);
    await handleRunApprove(
      socket,
      'approve-conflict',
      {
        ...request,
        approved: false,
      },
      daemonContext,
    );

    assert.deepEqual(readLastSentMessage(socket), {
      type: 'run.error',
      requestId: 'approve-conflict',
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
      computerSessionId: getSocketState(socket).computerSessionId,
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
