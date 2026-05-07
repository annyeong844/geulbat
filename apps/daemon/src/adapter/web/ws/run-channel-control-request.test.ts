import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';

import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import {
  readRunApproveRequest,
  readRunCancelRequest,
} from './run-channel-control-request.js';

const RUN_ID = testRunId(1);
const THREAD_ID = testThreadId(1);

function cancelRequest(runId: unknown): CancelRequest {
  return { runId } as unknown as CancelRequest;
}

function approvalRequest(
  overrides: Partial<Record<keyof ApprovalRequest, unknown>> = {},
): ApprovalRequest {
  return {
    callId: 'call-1',
    runId: RUN_ID,
    threadId: THREAD_ID,
    approved: true,
    grantScope: 'once',
    ...overrides,
  } as unknown as ApprovalRequest;
}

void test('readRunCancelRequest rejects empty runId', () => {
  assert.deepEqual(readRunCancelRequest(cancelRequest('')), {
    ok: false,
    message: 'runId is required',
  });
});

void test('readRunCancelRequest accepts runId', () => {
  assert.deepEqual(readRunCancelRequest(cancelRequest(RUN_ID)), {
    ok: true,
    runId: RUN_ID,
  });
});

void test('readRunApproveRequest rejects missing required fields', () => {
  assert.deepEqual(readRunApproveRequest(approvalRequest({ callId: '' })), {
    ok: false,
    message: 'callId is required',
  });
  assert.deepEqual(readRunApproveRequest(approvalRequest({ runId: '' })), {
    ok: false,
    message: 'runId is required',
  });
  assert.deepEqual(readRunApproveRequest(approvalRequest({ threadId: '' })), {
    ok: false,
    message: 'threadId is required',
  });
});

void test('readRunApproveRequest rejects invalid approval decision shape', () => {
  assert.deepEqual(
    readRunApproveRequest(approvalRequest({ approved: 'yes' })),
    { ok: false, message: 'approved (boolean) is required' },
  );
  assert.deepEqual(
    readRunApproveRequest(approvalRequest({ grantScope: 'forever' })),
    { ok: false, message: 'grantScope is required' },
  );
});

void test('readRunApproveRequest accepts valid approval request', () => {
  assert.deepEqual(
    readRunApproveRequest(approvalRequest({ grantScope: 'session' })),
    {
      ok: true,
      callId: 'call-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      approved: true,
      grantScope: 'session',
    },
  );
});
