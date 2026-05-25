import type { CSSProperties } from 'react';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';

const LEVEL_COLORS: Record<SideEffectLevel, string> = {
  none: '#888',
  read: '#1a73e8',
  write: '#e8a01a',
  destructive: '#d93025',
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
    padding: 12,
    borderRadius: 10,
    border: '1px solid #e8a01a',
    background: '#fffbe6',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    fontSize: 13,
  },
  compactTray: {
    marginTop: 8,
    marginBottom: 10,
    padding: 10,
    borderRadius: 8,
    border: '1px solid #e3e7ef',
    background: '#f8fafc',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    fontSize: 12,
  },
  compactHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    alignItems: 'baseline',
  },
  compactHint: {
    color: '#6b7280',
    fontSize: 11,
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
    color: '#8a5a00',
    marginBottom: 4,
  },
  summaryRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    padding: '2px 7px',
    borderRadius: 999,
    fontSize: 11,
    color: '#fff',
  },
  detailText: {
    marginTop: 4,
    color: '#6b7280',
    fontSize: 12,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: '#444',
  },
  inlineField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 12,
    color: '#444',
  },
  select: {
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #c7ced9',
    background: '#fff',
  },
  actionRow: {
    display: 'flex',
    gap: 8,
  },
  approveButton: {
    padding: '7px 16px',
    fontSize: 13,
    cursor: 'pointer',
    background: '#2f9e44',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
  },
  denyButton: {
    padding: '7px 16px',
    fontSize: 13,
    cursor: 'pointer',
    background: '#d93025',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
  },
  details: {
    borderTop: '1px solid #ecd8a8',
    paddingTop: 8,
  },
  detailsSummary: {
    cursor: 'pointer',
    fontSize: 12,
    color: '#555',
  },
  classRow: {
    marginTop: 8,
    marginBottom: 8,
    fontSize: 12,
    color: '#666',
  },
  preview: {
    background: '#f5f5f5',
    padding: 8,
    borderRadius: 6,
    fontSize: 12,
    overflow: 'auto',
    maxHeight: 120,
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
} satisfies Record<string, CSSProperties>;
