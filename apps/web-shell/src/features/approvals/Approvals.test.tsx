import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { ApprovalGrantScope } from '@geulbat/protocol/run-approval';

import { brandRunId, brandThreadId } from '../../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../../test-support/protocol-fixtures.js';
import { Approvals } from './Approvals.js';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

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

void test('Approvals resets approval pass when the compound pending approval identity changes', () => {
  withQuietReactTestRenderer(() => {
    const firstPending = makeApprovalRequiredFixture({
      callId: 'shared-call-id',
      runId: brandRunId('run-1'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    });
    const secondPending = makeApprovalRequiredFixture({
      callId: 'shared-call-id',
      runId: brandRunId('run-2'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000002'),
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <Approvals
          pending={firstPending}
          permissionMode="basic"
          onPermissionModeChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );
    });

    changeApprovalPass(renderer, 'session');
    assert.equal(getApprovalPassValue(renderer), 'session');

    act(() => {
      renderer.update(
        <Approvals
          pending={secondPending}
          permissionMode="basic"
          onPermissionModeChange={() => {}}
          onApprove={() => {}}
          onDeny={() => {}}
        />,
      );
    });

    assert.equal(getApprovalPassValue(renderer), 'once');
  });
});

function withQuietReactTestRenderer(callback: () => void): void {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('react-test-renderer is deprecated')
    ) {
      return;
    }
    originalConsoleError(...args);
  };

  try {
    callback();
  } finally {
    console.error = originalConsoleError;
  }
}

function changeApprovalPass(
  renderer: ReactTestRenderer,
  value: ApprovalGrantScope,
): void {
  act(() => {
    getApprovalPassSelect(renderer).props.onChange({
      target: { value },
    });
  });
}

function getApprovalPassValue(renderer: ReactTestRenderer): string {
  return String(getApprovalPassSelect(renderer).props.value);
}

function getApprovalPassSelect(renderer: ReactTestRenderer): ReactTestInstance {
  const approvalPassSelect = renderer.root
    .findAllByType('select')
    .find((select) =>
      select
        .findAllByType('option')
        .some((option) => option.props.value === 'session'),
    );
  assert.ok(approvalPassSelect, 'expected approval pass select to be rendered');
  return approvalPassSelect;
}
