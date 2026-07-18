import type { CSSProperties } from 'react';

// 좌측 rail 대화 목록 — Modern Heritage 토큰만 참조 (색상 리터럴 금지)
export function getThreadButtonStyle(isSelected: boolean): CSSProperties {
  return {
    background: isSelected ? 'var(--surface-container)' : 'none',
    boxShadow: isSelected ? 'inset 2px 0 0 0 var(--primary)' : 'none',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
    fontSize: 13,
    padding: '5px 8px',
    borderRadius: 4,
    color: 'var(--on-surface-variant)',
    fontFamily: 'var(--font-ui-label)',
    transition: 'background var(--transition-base)',
  };
}

export const threadListAlertStyle: CSSProperties = {
  marginBottom: 10,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--warning-bg)',
  color: 'var(--warning-text)',
  fontSize: 12,
  lineHeight: 1.45,
};

export const threadDeleteButtonStyle: CSSProperties = {
  marginTop: 4,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'var(--error)',
  fontSize: 11,
  lineHeight: 1.2,
  padding: '4px 8px',
  cursor: 'pointer',
  flexShrink: 0,
  fontFamily: 'var(--font-ui-label)',
};

export const threadListStyles = {
  section: {
    margin: '0 12px',
  },
  emptyState: {
    fontSize: 12,
    color: 'var(--on-surface-muted)',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
  },
  threadTitle: {
    fontWeight: 500,
    color: 'var(--on-surface)',
  },
  threadMeta: {
    fontSize: 11,
    color: 'var(--on-surface-muted)',
  },
} satisfies Record<string, CSSProperties>;
