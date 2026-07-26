import assert from 'node:assert/strict';
import test from 'node:test';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';

void test('buildApprovalSummary renders built-in write_file approvals with the target path', () => {
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
    title: '파일을 쓰려고 해요',
    label: '파일 쓰기',
    detail: 'docs/a.md',
  });
});

void test('buildApprovalSummary matches Computer-scoped classes by stripping the suffix', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'manage_files',
      approvalClass: toApprovalClass('manage_files:mkdir:computer'),
      argumentsPreview: {
        operation: 'mkdir',
        path: 'approval-demo',
      },
    }),
  );

  assert.deepEqual(summary, {
    title: '폴더를 만들려고 해요',
    label: '폴더 만들기',
    detail: 'approval-demo',
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
    title: '파일을 고치려고 해요',
    label: '파일 수정',
    detail: 'docs/a.md',
  });
});

void test('buildApprovalSummary renders rename approvals with an arrow target', () => {
  const summary = buildApprovalSummary(
    makeApprovalRequiredFixture({
      toolName: 'manage_files',
      approvalClass: 'manage_files:rename',
      argumentsPreview: {
        operation: 'rename',
        path: 'draft/ch1.md',
        destination: 'draft/ch1-rev.md',
      },
    }),
  );

  assert.deepEqual(summary, {
    title: '이름을 바꾸려고 해요',
    label: '이름 변경',
    detail: 'draft/ch1.md → draft/ch1-rev.md',
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
    title: 'loop_tool_approval_grant_store_test_tool 도구를 쓰려고 해요',
    label: 'loop_tool_approval_grant_store_test_tool',
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
    title: '파일을 정리하려고 해요',
    label: '파일 정리',
    detail: 'draft.md',
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
    title: '명령을 실행하려고 해요',
    label: '명령 실행',
    detail: 'npm run check -w apps/web-shell',
  });
});
