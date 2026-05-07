import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { Approvals } from './Approvals.js';

void test('Approvals truncates oversized arguments preview payloads', () => {
  const html = renderToStaticMarkup(
    <Approvals
      pending={makeApprovalRequiredFixture({
        sideEffectLevel: 'write',
        argumentsPreview: { content: 'x'.repeat(2000) },
      })}
      permissionMode="basic"
      onPermissionModeChange={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  assert.match(html, /\.\.\.\(truncated\)/);
  assert.equal(html.includes('x'.repeat(1500)), false);
  assert.match(html, /Permission Mode/);
  assert.match(html, /Approval Pass/);
  assert.match(html, /Advanced details/);
});

void test('Approvals shows summary-first rename copy and hides approval class behind advanced details', () => {
  const html = renderToStaticMarkup(
    <Approvals
      pending={makeApprovalRequiredFixture({
        toolName: 'manage_files',
        approvalClass: 'manage_files:rename',
        sideEffectLevel: 'write',
        argumentsPreview: {
          operation: 'rename',
          path: 'draft/ch1.md',
          destination: 'draft/ch1-rev.md',
        },
      })}
      permissionMode="basic"
      onPermissionModeChange={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  assert.match(html, /Rename draft\/ch1\.md -&gt; draft\/ch1-rev\.md/);
  assert.match(html, /Advanced details/);
  assert.match(html, /class:/);
});

void test('Approvals marks pending approval UI as a modal dialog', () => {
  const html = renderToStaticMarkup(
    <Approvals
      pending={makeApprovalRequiredFixture({
        approvalClass: 'write_file',
      })}
      permissionMode="basic"
      onPermissionModeChange={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-busy="false"/);
});

void test('Approvals renders compact mode control when no approval is pending', () => {
  const html = renderToStaticMarkup(
    <Approvals
      pending={null}
      permissionMode="full_access"
      onPermissionModeChange={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  assert.match(html, /Approval mode/);
  assert.match(html, /No pending approvals/);
  assert.match(html, /Full access/);
});
