import { useEffect, useId, useState } from 'react';
import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';

interface Props {
  pending: ApprovalRequired | null;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void> | void;
  onApprove: (
    pending: ApprovalRequired,
    grantScope: ApprovalGrantScope,
    permissionMode: PermissionMode,
  ) => Promise<void> | void;
  onDeny: (pending: ApprovalRequired) => Promise<void> | void;
}

const MAX_APPROVAL_PREVIEW_CHARS = 1200;

// 허용 범위 — 셀렉트 대신 칩. run은 현재 durable 실행의 수명이다.
const SCOPE_OPTIONS: ReadonlyArray<{
  value: ApprovalGrantScope;
  label: string;
}> = [
  { value: 'once', label: '이번만' },
  { value: 'run', label: '현재 실행' },
  { value: 'session', label: '이 컴퓨터 세션' },
];

const LEVEL_LABELS: Record<SideEffectLevel, string> = {
  none: '영향 없음',
  read: '읽기',
  write: '쓰기',
  destructive: '위험',
};

export function Approvals({
  pending,
  permissionMode,
  onPermissionModeChange,
  onApprove,
  onDeny,
}: Props) {
  const [grantScope, setGrantScope] = useState<ApprovalGrantScope>('once');
  const [pendingAction, setPendingAction] = useState<
    'approve' | 'approve_all' | 'deny' | null
  >(null);
  const titleId = useId();

  useEffect(() => {
    setGrantScope('once');
    setPendingAction(null);
  }, [pending?.callId, pending?.runId, pending?.threadId]);

  // 대기 중인 승인이 없으면 아무것도 차지하지 않는다 — 권한 방식 선택은
  // 입력창 footer가 owner다.
  if (!pending) {
    return null;
  }

  const activePending = pending;
  const summary = buildApprovalSummary(activePending);
  const controlsDisabled = pendingAction !== null;

  async function handleApprove(): Promise<void> {
    if (controlsDisabled) {
      return;
    }
    setPendingAction('approve');
    try {
      await Promise.resolve(
        onApprove(activePending, grantScope, permissionMode),
      );
    } finally {
      setPendingAction(null);
    }
  }

  // "다시 묻지 않기" — 전체 허용 모드로 전환하며 이번 요청도 함께 허용한다.
  async function handleApproveAll(): Promise<void> {
    if (controlsDisabled) {
      return;
    }
    setPendingAction('approve_all');
    try {
      await Promise.resolve(onPermissionModeChange('full_access'));
      await Promise.resolve(onApprove(activePending, 'session', 'full_access'));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDeny(): Promise<void> {
    if (controlsDisabled) {
      return;
    }
    setPendingAction('deny');
    try {
      await Promise.resolve(onDeny(activePending));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section
      className="approval-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={controlsDisabled}
    >
      <div className="approval-card-header">
        <span className="approval-card-dot" aria-hidden="true" />
        <strong id={titleId} className="approval-card-title">
          {summary.title}
        </strong>
        <span
          className={`approval-card-level ${activePending.sideEffectLevel}`}
        >
          {LEVEL_LABELS[activePending.sideEffectLevel]}
        </span>
      </div>

      {summary.detail ? (
        <code className="approval-card-target">{summary.detail}</code>
      ) : null}

      <div className="approval-card-scope" role="group" aria-label="허용 범위">
        <span className="approval-card-scope-label">허용 범위</span>
        {SCOPE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`approval-scope-chip${
              option.value === grantScope ? ' active' : ''
            }`}
            aria-pressed={option.value === grantScope}
            disabled={controlsDisabled}
            onClick={() => setGrantScope(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="approval-card-actions">
        <button
          className="approval-allow-button"
          onClick={() => void handleApprove()}
          disabled={controlsDisabled}
        >
          {pendingAction === 'approve' ? '허용 중…' : '허용'}
        </button>
        <button
          className="approval-deny-button"
          onClick={() => void handleDeny()}
          disabled={controlsDisabled}
        >
          {pendingAction === 'deny' ? '거부 중…' : '거부'}
        </button>
        <button
          className="approval-allow-all-button"
          onClick={() => void handleApproveAll()}
          disabled={controlsDisabled}
          title="전체 허용 모드로 바꾸고 앞으로는 승인 없이 진행합니다"
        >
          {pendingAction === 'approve_all' ? '전환 중…' : '다시 묻지 않기'}
        </button>
      </div>

      <details className="approval-advanced">
        <summary>자세히</summary>
        <div className="approval-advanced-class">
          분류: <code>{pending.approvalClass}</code> · 도구:{' '}
          <code>{pending.toolName}</code>
        </div>
        <pre className="approval-advanced-preview">
          {formatArgumentsPreview(pending.argumentsPreview)}
        </pre>
      </details>
    </section>
  );
}

function formatArgumentsPreview(
  argumentsPreview: ApprovalRequired['argumentsPreview'],
): string {
  const text = JSON.stringify(argumentsPreview, null, 2);
  if (text.length <= MAX_APPROVAL_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_APPROVAL_PREVIEW_CHARS)}\n...(truncated)`;
}
