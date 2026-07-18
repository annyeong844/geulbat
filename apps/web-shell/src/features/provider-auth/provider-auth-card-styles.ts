import type { CSSProperties } from 'react';

// 우측 어시스턴트 provider 연결 카드 — Modern Heritage 토큰만 참조
export const providerAuthCardStyles = {
  section: {
    borderRadius: 8,
    padding: 12,
    background: 'var(--surface-container-lowest)',
    boxShadow: 'var(--elev-card)',
  },
  description: {
    fontSize: 13,
    color: 'var(--on-surface-variant)',
    lineHeight: 1.5,
    margin: '4px 0 8px',
  },
  providerList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  providerRow: {
    paddingTop: 10,
    borderTop: '1px solid var(--outline-variant)',
  },
  providerHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    fontSize: 13,
  },
  statusLabel: {
    fontSize: 11,
    color: 'var(--on-surface-muted)',
    textTransform: 'uppercase',
  },
  alert: {
    marginBottom: 10,
    padding: '8px 10px',
    borderRadius: 8,
    background: 'var(--warning-bg)',
    color: 'var(--warning-text)',
    fontSize: 12,
    lineHeight: 1.45,
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
} satisfies Record<string, CSSProperties>;

export function getProviderAuthButtonStyle(
  variant: 'primary' | 'danger',
  disabled: boolean,
): CSSProperties {
  return {
    padding: '6px 14px',
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: 'var(--font-ui-label)',
    cursor: disabled ? 'default' : 'pointer',
    background: variant === 'danger' ? 'transparent' : 'var(--primary)',
    color: variant === 'danger' ? 'var(--error)' : 'var(--on-primary)',
    border: 'none',
    borderRadius: 999,
    opacity: disabled ? 0.5 : 1,
  };
}
