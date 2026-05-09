import { useEffect, useId, useState } from 'react';
import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';
import { approvalStyles, getApprovalBadgeStyle } from './approval-styles.js';

interface Props {
  pending: ApprovalRequired | null;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void> | void;
  onApprove: (
    pending: ApprovalRequired,
    grantScope: ApprovalGrantScope,
  ) => Promise<void> | void;
  onDeny: (pending: ApprovalRequired) => Promise<void> | void;
}

const MAX_APPROVAL_PREVIEW_CHARS = 1200;

export function Approvals({
  pending,
  permissionMode,
  onPermissionModeChange,
  onApprove,
  onDeny,
}: Props) {
  const [grantScope, setGrantScope] = useState<ApprovalGrantScope>('once');
  const [pendingAction, setPendingAction] = useState<'approve' | 'deny' | null>(
    null,
  );
  const titleId = useId();

  useEffect(() => {
    setGrantScope('once');
    setPendingAction(null);
  }, [pending?.callId, pending?.runId, pending?.threadId]);

  if (!pending) {
    return (
      <section className="approvals" style={styles.compactTray}>
        <div style={styles.compactHeader}>
          <strong>Approval mode</strong>
          <span style={styles.compactHint}>No pending approvals</span>
        </div>
        <PermissionModeSelector
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          compact
        />
      </section>
    );
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
      await Promise.resolve(onApprove(activePending, grantScope));
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
      className="approvals"
      style={styles.tray}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={controlsDisabled}
    >
      <div style={styles.headerRow}>
        <div>
          <div style={styles.eyebrow}>Approval required</div>
          <div style={styles.summaryRow}>
            <strong id={titleId}>{summary.title}</strong>
            <span style={getApprovalBadgeStyle(activePending.sideEffectLevel)}>
              {activePending.sideEffectLevel}
            </span>
          </div>
          {summary.detail ? (
            <div style={styles.detailText}>{summary.detail}</div>
          ) : null}
        </div>
      </div>
      <PermissionModeSelector
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        compact
        disabled={controlsDisabled}
      />
      <label style={styles.field}>
        Approval Pass
        <select
          value={grantScope}
          disabled={controlsDisabled}
          onChange={(event) =>
            setGrantScope(event.target.value as ApprovalGrantScope)
          }
          style={styles.select}
        >
          <option value="once">Once</option>
          <option value="run">This run</option>
          <option value="thread">This thread</option>
          <option value="session">This session</option>
        </select>
      </label>

      <div style={styles.actionRow}>
        <button
          onClick={() => void handleApprove()}
          disabled={controlsDisabled}
          style={styles.approveButton}
        >
          {pendingAction === 'approve' ? 'Approving...' : 'Approve'}
        </button>
        <button
          onClick={() => void handleDeny()}
          disabled={controlsDisabled}
          style={styles.denyButton}
        >
          {pendingAction === 'deny' ? 'Denying...' : 'Deny'}
        </button>
      </div>

      <details style={styles.details}>
        <summary style={styles.detailsSummary}>Advanced details</summary>
        <div style={styles.classRow}>
          class: <code>{pending.approvalClass}</code>
        </div>
        <pre style={styles.preview}>
          {formatArgumentsPreview(pending.argumentsPreview)}
        </pre>
      </details>
    </section>
  );
}

function PermissionModeSelector(props: {
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void> | void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const {
    permissionMode,
    onPermissionModeChange,
    compact = false,
    disabled = false,
  } = props;

  return (
    <label style={compact ? styles.inlineField : styles.field}>
      Permission Mode
      <select
        value={permissionMode}
        disabled={disabled}
        onChange={(event) =>
          void onPermissionModeChange(event.target.value as PermissionMode)
        }
        style={styles.select}
      >
        <option value="basic">Basic</option>
        <option value="full_access">Full access</option>
      </select>
    </label>
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

const styles = approvalStyles;
