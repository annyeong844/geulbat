import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_GRANT_SCOPES,
  isApprovalClass,
  isApprovalGrantScope,
  isApprovalRequest,
  isApprovalRequired,
  toApprovalClass,
  isWellKnownApprovalClass,
  WELL_KNOWN_APPROVAL_CLASSES,
} from './run-approval.js';
import type { RunId, ThreadId } from './ids.js';
import { assertEveryFieldIsValidated } from './test-support/field-coverage.js';

const RUN_ID = 'run-approval-1';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';

void test('approval grant lifetimes exclude conversation threads', () => {
  assert.deepEqual(APPROVAL_GRANT_SCOPES, ['once', 'run', 'session']);
  assert.equal(isApprovalGrantScope('thread'), false);
  assert.equal(
    isApprovalRequest({
      callId: 'call-thread-scope',
      runId: RUN_ID,
      threadId: THREAD_ID,
      approved: true,
      grantScope: 'thread',
    }),
    false,
  );
});

void test('isWellKnownApprovalClass accepts built-in approval classes and rejects unknown values', () => {
  for (const approvalClass of WELL_KNOWN_APPROVAL_CLASSES) {
    assert.equal(isWellKnownApprovalClass(approvalClass), true);
  }

  assert.equal(
    isWellKnownApprovalClass('loop_tool_approval_grant_store_test_tool'),
    false,
  );
  assert.equal(isWellKnownApprovalClass('write'), false);
});

void test('isApprovalRequired remains open to custom approvalClass strings', () => {
  assert.equal(
    isApprovalRequired({
      callId: 'call-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'loop_tool_approval_grant_store_test_tool',
      approvalClass: 'loop_tool_approval_grant_store_test_tool',
      permissionMode: 'basic',
      argumentsPreview: { path: 'draft.md' },
      sideEffectLevel: 'destructive',
    }),
    true,
  );
});

void test('isApprovalRequired accepts optional PTC callback source payloads', () => {
  assert.equal(
    isApprovalRequired({
      callId: 'call-parent::nested-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'write_file',
      approvalClass: 'write_file',
      permissionMode: 'basic',
      argumentsPreview: { path: 'draft.md' },
      sideEffectLevel: 'write',
      source: {
        kind: 'ptc_callback',
        parentCallId: 'call-parent',
        runtimeToolCallId: 'runtime-call-1',
        cellId: 'ptc_cell_runtime_1',
      },
    }),
    true,
  );
  assert.equal(
    isApprovalRequired({
      callId: 'call-parent::nested-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'write_file',
      approvalClass: 'write_file',
      permissionMode: 'basic',
      argumentsPreview: { path: 'draft.md' },
      sideEffectLevel: 'write',
      source: { kind: 'ptc_callback', parentCallId: 'call-parent' },
    }),
    false,
  );
});

void test('approval decisions are exact while server projections remain additive', () => {
  const decision = {
    callId: 'call-1',
    runId: RUN_ID,
    threadId: THREAD_ID,
    approved: true,
    grantScope: 'once',
  } as const;
  assert.equal(isApprovalRequest(decision), true);
  assert.equal(
    isApprovalRequest({ ...decision, permissionMode: 'full_access' }),
    true,
  );
  assert.equal(
    isApprovalRequest({ ...decision, permissionMode: 'unrestricted' }),
    false,
  );
  assert.equal(
    isApprovalRequest({ ...decision, futureGrantSelector: 'workspace' }),
    false,
  );

  assert.equal(
    isApprovalRequired({
      callId: 'call-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'write_file',
      approvalClass: 'write_file',
      permissionMode: 'basic',
      argumentsPreview: { path: 'draft.md' },
      sideEffectLevel: 'write',
      explanatoryHint: 'future informational field',
    }),
    true,
  );
});

void test('approvalClass uses a centralized normalized token guard', () => {
  assert.equal(isApprovalClass('write_file'), true);
  assert.equal(
    isApprovalClass('loop_tool_approval_grant_store_test_tool'),
    true,
  );
  assert.equal(isApprovalClass('manage_files:delete'), true);
  assert.equal(isApprovalClass('contains spaces'), false);
  assert.equal(isApprovalClass('UPPERCASE'), false);

  assert.equal(toApprovalClass('write_file'), 'write_file');
  assert.throws(() => toApprovalClass('contains spaces'));
});

void test('every declared approval contract field is actually validated', () => {
  assertEveryFieldIsValidated(
    'ApprovalRequired',
    isApprovalRequired,
    {
      callId: 'call-1',
      runId: RUN_ID as RunId,
      threadId: THREAD_ID as ThreadId,
      toolName: 'write_file',
      approvalClass: 'write_file',
      permissionMode: 'basic',
      argumentsPreview: { path: 'docs/a.md' },
      sideEffectLevel: 'write',
      source: {
        kind: 'artifact_frame',
        scopeHandle: 'scope-1',
        runtimeToolCallId: 'rt-call-1',
      },
    },
    {
      callId: 42,
      runId: 42,
      threadId: '../escape',
      toolName: 42,
      approvalClass: 42,
      permissionMode: 'invented-mode',
      argumentsPreview: 'not-a-record',
      sideEffectLevel: 'invented-level',
      source: 'not-a-record',
    },
  );

  assertEveryFieldIsValidated(
    'ApprovalRequest',
    isApprovalRequest,
    {
      callId: 'call-1',
      runId: RUN_ID as RunId,
      threadId: THREAD_ID as ThreadId,
      approved: true,
      grantScope: 'once',
      permissionMode: 'basic',
    },
    {
      callId: 42,
      runId: 42,
      threadId: '../escape',
      approved: 'yes',
      grantScope: 'thread',
      permissionMode: 'invented-mode',
    },
  );
});
