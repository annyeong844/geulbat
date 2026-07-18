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

void test('buildApprovalSummary renders built-in apply_patch approvals with target detail', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'apply_patch',
      approvalClass: 'apply_patch',
      argumentsPreview: {
        patch: [
          '*** Begin Patch',
          '*** Update File: docs/a.md',
          '@@',
          '-old',
          '+new',
          '*** End Patch',
        ].join('\n'),
      },
    }),
  );

  assert.deepEqual(summary, {
    title: 'Apply patch to docs/a.md',
    detail: 'Update file',
  });
});

void test('buildApprovalSummary labels unsupported apply_patch delete previews explicitly', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'apply_patch',
      approvalClass: 'apply_patch',
      argumentsPreview: {
        patch: [
          '*** Begin Patch',
          '*** Delete File: docs/a.md',
          '*** End Patch',
        ].join('\n'),
      },
    }),
  );

  assert.deepEqual(summary, {
    title: 'Apply patch to docs/a.md',
    detail: 'Unsupported delete patch',
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

void test('buildApprovalSummary renders exec_command approvals with command detail', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'exec_command',
      approvalClass: 'exec_command',
      argumentsPreview: {
        cmd: 'npm run check -w apps/web-shell',
      },
    }),
  );

  assert.deepEqual(summary, {
    title: 'Run shell command',
    detail: 'npm run check -w apps/web-shell',
  });
});
