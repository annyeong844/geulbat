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
  assert.match(html, /허용 범위/u);
  assert.match(html, /자세히/u);
  // 권한 방식 셀렉트는 입력창 footer가 owner — 카드에서는 제거됐다
  assert.doesNotMatch(html, /Permission Mode/u);
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

  assert.match(html, /이름을 바꾸려고 해요/u);
  assert.match(html, /draft\/ch1\.md → draft\/ch1-rev\.md/u);
  assert.match(html, /자세히/u);
  assert.match(html, /분류:/u);
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

void test('Approvals offers only explicit once, run, and computer-session lifetimes', () => {
  const html = renderToStaticMarkup(
    <Approvals
      pending={makeApprovalRequiredFixture()}
      permissionMode="basic"
      onPermissionModeChange={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  assert.match(html, /이번만/u);
  assert.match(html, /이번 답변/u);
  assert.match(html, /이 컴퓨터 세션/u);
  assert.doesNotMatch(html, /<option/u);
  assert.doesNotMatch(html, /This thread|이 스레드/u);
});

void test('Approvals renders nothing when no approval is pending', () => {
  // 권한 방식 선택은 입력창 footer가 owner — 대기 승인 없으면 공간 미점유
  const html = renderToStaticMarkup(
    <Approvals
      pending={null}
      permissionMode="full_access"
      onPermissionModeChange={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  );

  assert.equal(html, '');
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

    selectApprovalScope(renderer, '이 컴퓨터 세션');
    assert.equal(getSelectedApprovalScopeLabel(renderer), '이 컴퓨터 세션');

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

    assert.equal(getSelectedApprovalScopeLabel(renderer), '이번만');
  });
});

void test('Approvals submits the selected permission mode with the explicit approval', async () => {
  await withQuietReactTestRendererAsync(async () => {
    const pending = makeApprovalRequiredFixture();
    let received:
      | {
          pending: typeof pending;
          grantScope: ApprovalGrantScope;
          permissionMode: string;
        }
      | undefined;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Approvals
          pending={pending}
          permissionMode="full_access"
          onPermissionModeChange={() => {}}
          onApprove={(submittedPending, grantScope, permissionMode) => {
            received = {
              pending: submittedPending,
              grantScope,
              permissionMode,
            };
          }}
          onDeny={() => {}}
        />,
      );
    });

    const approveButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === '허용');
    assert.ok(approveButton);
    await act(async () => {
      approveButton.props.onClick();
    });

    assert.deepEqual(received, {
      pending,
      grantScope: 'once',
      permissionMode: 'full_access',
    });
  });
});

void test('Approvals "다시 묻지 않기" switches to full access and approves in one step', async () => {
  await withQuietReactTestRendererAsync(async () => {
    const pending = makeApprovalRequiredFixture();
    const modeChanges: string[] = [];
    let received:
      | { grantScope: ApprovalGrantScope; permissionMode: string }
      | undefined;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Approvals
          pending={pending}
          permissionMode="basic"
          onPermissionModeChange={(mode) => {
            modeChanges.push(mode);
          }}
          onApprove={(_submittedPending, grantScope, permissionMode) => {
            received = { grantScope, permissionMode };
          }}
          onDeny={() => {}}
        />,
      );
    });

    const approveAllButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === '다시 묻지 않기');
    assert.ok(approveAllButton);
    await act(async () => {
      approveAllButton.props.onClick();
    });

    assert.deepEqual(modeChanges, ['full_access']);
    assert.deepEqual(received, {
      grantScope: 'session',
      permissionMode: 'full_access',
    });
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

async function withQuietReactTestRendererAsync(
  callback: () => Promise<void>,
): Promise<void> {
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
    await callback();
  } finally {
    console.error = originalConsoleError;
  }
}

function selectApprovalScope(renderer: ReactTestRenderer, label: string): void {
  const scopeButton = findScopeButton(renderer, label);
  act(() => {
    scopeButton.props.onClick();
  });
}

function getSelectedApprovalScopeLabel(renderer: ReactTestRenderer): string {
  const selected = renderer.root
    .findAllByType('button')
    .find((button) => button.props['aria-pressed'] === true);
  assert.ok(selected, 'expected a selected approval scope pill');
  return String(selected.props.children);
}

function findScopeButton(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance {
  const scopeButton = renderer.root
    .findAllByType('button')
    .find(
      (button) =>
        button.props['aria-pressed'] !== undefined &&
        button.props.children === label,
    );
  assert.ok(scopeButton, `expected approval scope pill: ${label}`);
  return scopeButton;
}
