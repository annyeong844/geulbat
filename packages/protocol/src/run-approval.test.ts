import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isApprovalClass,
  isApprovalRequired,
  toApprovalClass,
  isWellKnownApprovalClass,
  WELL_KNOWN_APPROVAL_CLASSES,
} from './run-approval.js';

const RUN_ID = 'run-approval-1';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';

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
