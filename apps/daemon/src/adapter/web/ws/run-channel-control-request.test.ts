import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { RunInterjectRequest } from '@geulbat/protocol/run-channel';

import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import {
  readRunApproveRequest,
  readRunCancelRequest,
  readRunInterjectCancelRequest,
  readRunInterjectFlushRequest,
  readRunInterjectRequest,
  readRunToolRequest,
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

function interjectRequest(
  overrides: Partial<Record<keyof RunInterjectRequest, unknown>> = {},
): Record<string, unknown> {
  return {
    runId: RUN_ID,
    text: 'please adjust this run',
    ...overrides,
  };
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
    { ok: false, message: 'grantScope must be once, run, or session' },
  );
  assert.deepEqual(
    readRunApproveRequest(approvalRequest({ grantScope: 'thread' })),
    { ok: false, message: 'grantScope must be once, run, or session' },
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

void test('readRunInterjectRequest rejects malformed request objects', () => {
  assert.deepEqual(readRunInterjectRequest(null), {
    ok: false,
    message: 'request must be an object',
  });
  assert.deepEqual(readRunInterjectRequest([]), {
    ok: false,
    message: 'request must be an object',
  });
});

void test('readRunInterjectRequest rejects missing required fields', () => {
  assert.deepEqual(readRunInterjectRequest(interjectRequest({ runId: '' })), {
    ok: false,
    message: 'runId is required',
  });
  assert.deepEqual(
    readRunInterjectRequest(interjectRequest({ runId: 'bad run id' })),
    {
      ok: false,
      message: 'runId is required',
    },
  );
  assert.deepEqual(readRunInterjectRequest(interjectRequest({ text: '' })), {
    ok: false,
    message: 'text is required',
  });
  assert.deepEqual(readRunInterjectRequest(interjectRequest({ text: '   ' })), {
    ok: false,
    message: 'text is required',
  });
});

void test('readRunInterjectRequest accepts a valid request without trimming text', () => {
  assert.deepEqual(
    readRunInterjectRequest(interjectRequest({ text: '  keep this  ' })),
    {
      ok: true,
      runId: RUN_ID,
      text: '  keep this  ',
    },
  );
});

void test('full interject decoders reject unknown mutation fields', () => {
  assert.equal(
    readRunInterjectRequest({
      ...interjectRequest(),
      futureMode: 'replace',
    }).ok,
    false,
  );
  assert.equal(
    readRunInterjectCancelRequest({
      runId: RUN_ID,
      receivedSeq: 1,
      cancelAll: true,
    }).ok,
    false,
  );
  assert.equal(
    readRunInterjectFlushRequest({ runId: RUN_ID, force: true }).ok,
    false,
  );
});

void test('readRunInterjectCancelRequest validates the opaque envelope body', () => {
  assert.deepEqual(readRunInterjectCancelRequest(null), {
    ok: false,
    message: 'request must be an object',
  });
  assert.deepEqual(
    readRunInterjectCancelRequest({ runId: 'bad run id', receivedSeq: 1 }),
    { ok: false, message: 'runId is required' },
  );
  assert.deepEqual(
    readRunInterjectCancelRequest({ runId: RUN_ID, receivedSeq: 0 }),
    { ok: false, message: 'receivedSeq must be a positive integer' },
  );
  assert.deepEqual(
    readRunInterjectCancelRequest({ runId: RUN_ID, receivedSeq: 1.5 }),
    { ok: false, message: 'receivedSeq must be a positive integer' },
  );
  assert.deepEqual(
    readRunInterjectCancelRequest({ runId: RUN_ID, receivedSeq: 1 }),
    { ok: true, runId: RUN_ID, receivedSeq: 1 },
  );
});

void test('readRunInterjectFlushRequest validates the opaque envelope body', () => {
  assert.deepEqual(readRunInterjectFlushRequest(null), {
    ok: false,
    message: 'request must be an object',
  });
  assert.deepEqual(readRunInterjectFlushRequest({ runId: 'bad run id' }), {
    ok: false,
    message: 'runId is required',
  });
  assert.deepEqual(readRunInterjectFlushRequest({ runId: RUN_ID }), {
    ok: true,
    runId: RUN_ID,
  });
});

void test('readRunToolRequest accepts a frame tool call with parent-injected context', () => {
  const threadId = testThreadId(90);
  const result = readRunToolRequest({
    threadId,
    toolName: 'read_file',
    args: { path: 'draft.md' },
    scopeHandle: 'scope-1',
    frameRequestId: 'af-1',
    workingDirectory: 'Users/sample/Documents',
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      threadId,
      toolName: 'read_file',
      args: { path: 'draft.md' },
      scopeHandle: 'scope-1',
      frameRequestId: 'af-1',
      workingDirectory: 'Users/sample/Documents',
    },
  });
});

void test('readRunToolRequest rejects missing or malformed frame tool fields', () => {
  const threadId = testThreadId(91);
  const valid = {
    threadId,
    toolName: 'read_file',
    args: {},
    scopeHandle: 'scope-1',
    frameRequestId: 'af-1',
  };

  assert.equal(readRunToolRequest('nope').ok, false);
  assert.equal(
    readRunToolRequest({ ...valid, threadId: 'not-a-thread-id!' }).ok,
    false,
  );
  assert.equal(readRunToolRequest({ ...valid, toolName: '  ' }).ok, false);
  assert.equal(readRunToolRequest({ ...valid, args: 'rm -rf' }).ok, false);
  assert.equal(readRunToolRequest({ ...valid, scopeHandle: '' }).ok, false);
  assert.equal(readRunToolRequest({ ...valid, frameRequestId: '' }).ok, false);
  assert.equal(
    readRunToolRequest({ ...valid, workingDirectory: 42 }).ok,
    false,
  );
  assert.equal(
    readRunToolRequest({ ...valid, approvalGranted: true }).ok,
    false,
  );
});
