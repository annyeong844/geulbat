import assert from 'node:assert/strict';
import test from 'node:test';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';

void test('buildApprovalSummary renders built-in write_file approvals with content detail', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'write_file',
      approvalClass: 'write_file',
      argumentsPreview: {
        path: 'docs/a.md',
        content: 'hello\nworld',
      },
    }),
  );

  assert.deepEqual(summary, {
    title: 'Write docs/a.md',
    detail: '2 lines of content',
  });
});

void test('buildApprovalSummary falls back for custom approval classes', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'loop_tool_approval_grant_store_test_tool',
      approvalClass: toApprovalClass(
        'loop_tool_approval_grant_store_test_tool',
      ),
      argumentsPreview: {
        path: 'draft.md',
      },
    }),
  );

  assert.deepEqual(summary, {
    title: 'Run loop_tool_approval_grant_store_test_tool',
    detail: 'draft.md',
  });
});

void test('buildApprovalSummary renders generic manage_files fallback for built-in class', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'manage_files',
      approvalClass: 'manage_files',
      argumentsPreview: {
        path: 'draft.md',
      },
    }),
  );

  assert.deepEqual(summary, {
    title: 'Manage draft.md',
    detail: null,
  });
});
