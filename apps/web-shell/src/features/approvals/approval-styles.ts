import type { CSSProperties } from 'react';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';

// approval card — warning tone, Modern Heritage (§3.3.2 #8)
const LEVEL_COLORS: Record<SideEffectLevel, string> = {
  none: 'var(--on-surface-muted)',
  read: 'var(--secondary)',
  write: 'var(--tertiary)',
  destructive: 'var(--error)',
};

export function getApprovalBadgeStyle(level: SideEffectLevel): CSSProperties {
  return {
    ...approvalStyles.badge,
    background: LEVEL_COLORS[level],
  };
}

export const approvalStyles = {
  tray: {
    marginTop: 8,
    marginBottom: 10,
    padding: '12px 14px',
    borderRadius: 8,
    background: 'var(--warning-bg)',
    color: 'var(--warning-text)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    fontSize: 13,
    fontFamily: 'var(--font-ui-label)',
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
  },
  eyebrow: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--warning-text)',
    opacity: 0.8,
    marginBottom: 4,
  },
  summaryRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--on-primary)',
  },
  detailText: {
    marginTop: 4,
    color: 'var(--warning-text)',
    opacity: 0.85,
    fontSize: 11.5,
    fontFamily: 'var(--font-ui-mono)',
    wordBreak: 'break-all',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: 'var(--on-surface-variant)',
  },
  inlineField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: 'var(--on-surface-variant)',
  },
  select: {
    padding: '6px 8px',
    borderRadius: 4,
    border: 'none',
    borderBottom: '1px solid rgba(50, 34, 20, 0.2)',
    background: 'var(--surface-container-lowest)',
    color: 'var(--on-surface)',
    fontFamily: 'var(--font-ui-label)',
    fontSize: 12,
  },
  actionRow: {
    display: 'flex',
    gap: 8,
  },
  approveButton: {
    padding: '7px 16px',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--primary)',
    color: 'var(--on-primary)',
    border: 'none',
    borderRadius: 999,
    fontFamily: 'var(--font-ui-label)',
  },
  denyButton: {
    padding: '7px 16px',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--warning-text)',
    border: 'none',
    borderRadius: 999,
    fontFamily: 'var(--font-ui-label)',
  },
  details: {
    borderTop: '1px solid rgba(90, 74, 31, 0.2)',
    paddingTop: 8,
  },
  detailsSummary: {
    cursor: 'pointer',
    fontSize: 12,
    color: 'var(--warning-text)',
    opacity: 0.85,
  },
  classRow: {
    marginTop: 8,
    marginBottom: 8,
    fontSize: 12,
    color: 'var(--warning-text)',
    opacity: 0.85,
  },
  preview: {
    background: 'rgba(255, 255, 255, 0.6)',
    padding: 8,
    borderRadius: 4,
    fontSize: 11.5,
    fontFamily: 'var(--font-ui-mono)',
    overflow: 'auto',
    maxHeight: 120,
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
} satisfies Record<string, CSSProperties>;
