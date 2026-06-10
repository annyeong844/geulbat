import test from 'node:test';
import assert from 'node:assert/strict';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { brandProjectId, brandThreadId } from '../lib/id-brand-helpers.js';
import {
  buildApprovalDecisionRequest,
  buildPromptRunRequest,
  buildRunStartRequest,
  cancelRunSession,
  resolveOptimisticRunPrompt,
  startRunRequestCommand,
  submitApprovalDecision,
} from './run-session-commands.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';

const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);
const PROJECT_ID = brandProjectId('project-1');

function createClientStub() {
  const calls: string[] = [];
  const startRequests: unknown[] = [];
  const approveRequests: unknown[] = [];
  const cancelRequests: unknown[] = [];

  return {
    calls,
    startRequests,
    approveRequests,
    cancelRequests,
    client: {
      async start(request: RunRequest) {
        calls.push('start');
        startRequests.push(request);
        return 'request-start';
      },
      async approve(request: ApprovalRequest) {
        calls.push('approve');
        approveRequests.push(request);
        return 'request-approve';
      },
      async cancel(request: CancelRequest) {
        calls.push('cancel');
        cancelRequests.push(request);
        return 'request-cancel';
      },
      close() {
        calls.push('close');
      },
      async connect() {
        calls.push('connect');
        return undefined;
      },
    },
  };
}

void test('buildPromptRunRequest builds a prompt request from selected thread/file context', () => {
  assert.deepEqual(
    buildPromptRunRequest({
      prompt: 'hello',
      projectId: 'project-1',
      selectedThreadId: THREAD_ID_VALUE,
      selectedFile: 'docs/a.md',
      permissionMode: 'basic',
    }),
    {
      prompt: 'hello',
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      currentFile: 'docs/a.md',
      permissionMode: 'basic',
    },
  );
});

void test('buildRunStartRequest fills the default permission mode only when missing', () => {
  assert.deepEqual(
    buildRunStartRequest({
      request: {
        prompt: 'hello',
        projectId: PROJECT_ID,
      },
      permissionMode: 'basic',
    }),
    {
      prompt: 'hello',
      projectId: PROJECT_ID,
      permissionMode: 'basic',
    },
  );

  assert.deepEqual(
    buildRunStartRequest({
      request: {
        prompt: 'hello',
        projectId: PROJECT_ID,
        permissionMode: 'full_access',
      },
      permissionMode: 'basic',
    }),
    {
      prompt: 'hello',
      projectId: PROJECT_ID,
      permissionMode: 'full_access',
    },
  );
});

void test('resolveOptimisticRunPrompt prefers displayPrompt, then explicit optimisticPrompt, then raw prompt', () => {
  assert.equal(
    resolveOptimisticRunPrompt({
      prompt: 'hidden prompt',
      displayPrompt: 'visible prompt',
      projectId: PROJECT_ID,
    }),
    'visible prompt',
  );
  assert.equal(
    resolveOptimisticRunPrompt(
      {
        prompt: 'hidden prompt',
        projectId: PROJECT_ID,
      },
      'fallback prompt',
    ),
    'fallback prompt',
  );
  assert.equal(
    resolveOptimisticRunPrompt({
      prompt: 'raw prompt',
      projectId: PROJECT_ID,
    }),
    'raw prompt',
  );
});

void test('startRunRequestCommand dispatches run start and invokes transport', async () => {
  const { client, calls, startRequests } = createClientStub();
  const result = await startRunRequestCommand({
    client,
    request: {
      prompt: 'hidden prompt',
      displayPrompt: 'visible prompt',
      projectId: PROJECT_ID,
      currentFile: 'docs/a.md',
    },
  });

  assert.deepEqual(result, { kind: 'started', threadId: null });
  assert.deepEqual(calls, ['start']);
  assert.equal(startRequests.length, 1);
});

void test('startRunRequestCommand returns a failure result when transport start fails', async () => {
  const { client } = createClientStub();

  client.start = async () => {
    throw new Error('start transport down');
  };

  const result = await startRunRequestCommand({
    client,
    request: {
      prompt: 'hidden prompt',
      projectId: PROJECT_ID,
    },
  });

  assert.deepEqual(result, {
    kind: 'failed',
    message: 'start transport down',
  });
});

void test('submitApprovalDecision clears approval after sending an allow decision', async () => {
  const { client, calls, approveRequests } = createClientStub();
  const pending = makeApprovalRequiredFixture();

  const result = await submitApprovalDecision({
    client,
    pending,
    approved: true,
    grantScope: 'session',
  });

  assert.deepEqual(calls, ['approve']);
  assert.deepEqual(approveRequests, [
    buildApprovalDecisionRequest({
      pending,
      approved: true,
      grantScope: 'session',
    }),
  ]);
  assert.deepEqual(result, { kind: 'approved' });
});

void test('submitApprovalDecision keeps approval visible after sending a deny decision', async () => {
  const { client, calls, approveRequests } = createClientStub();
  const pending = makeApprovalRequiredFixture();

  const result = await submitApprovalDecision({
    client,
    pending,
    approved: false,
    grantScope: 'once',
  });

  assert.deepEqual(calls, ['approve']);
  assert.deepEqual(approveRequests, [
    buildApprovalDecisionRequest({
      pending,
      approved: false,
      grantScope: 'once',
    }),
  ]);
  assert.deepEqual(result, { kind: 'denied' });
});

void test('submitApprovalDecision keeps approval pending and surfaces an error when approval send fails', async () => {
  const { client } = createClientStub();
  const pending = makeApprovalRequiredFixture({
    permissionMode: 'basic',
  });

  client.approve = async () => {
    throw new Error('approval transport down');
  };

  const result = await submitApprovalDecision({
    client,
    pending,
    approved: true,
    grantScope: 'session',
  });

  assert.deepEqual(result, {
    kind: 'failed',
    message: 'approval transport down',
  });
});

void test('cancelRunSession reconnects the transport when cancelling a pending start', async () => {
  const { client, calls } = createClientStub();
  const result = await cancelRunSession({
    client,
    activeRunId: null,
    phase: 'starting',
  });

  assert.deepEqual(calls, ['close', 'connect']);
  assert.deepEqual(result, { kind: 'start_cancelled' });
});

void test('cancelRunSession sends a cancel request for an active run', async () => {
  const { client, calls, cancelRequests } = createClientStub();

  const result = await cancelRunSession({
    client,
    activeRunId: 'run-1',
    phase: 'running',
  });

  assert.deepEqual(calls, ['cancel']);
  assert.equal(cancelRequests.length, 1);
  assert.deepEqual(result, { kind: 'cancel_requested' });
});

void test('cancelRunSession keeps the transport failure visible when reconnect fails during pending start cancel', async () => {
  const { client, calls } = createClientStub();

  client.connect = async () => {
    calls.push('connect_failed');
    throw new Error('socket down');
  };

  const result = await cancelRunSession({
    client,
    activeRunId: null,
    phase: 'starting',
  });

  assert.deepEqual(calls, ['close', 'connect_failed']);
  assert.deepEqual(result, {
    kind: 'reconnect_failed',
    message: 'socket down',
  });
});

void test('cancelRunSession does not clear approval when there is nothing to cancel', async () => {
  const { client, calls } = createClientStub();
  const result = await cancelRunSession({
    client,
    activeRunId: null,
    phase: 'idle',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { kind: 'noop' });
});
