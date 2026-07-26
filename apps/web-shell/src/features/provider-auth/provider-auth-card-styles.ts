import type { CSSProperties } from 'react';

// 설정의 provider 연결 카드 — Modern Heritage 토큰만 참조
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
  },
  // 세션 전체 보기 행과 같은 결 — 균일한 상하 여백 + 헤어라인 구분
  providerRow: {
    padding: '14px 0',
    borderBottom: '1px solid var(--outline-variant)',
  },
  // 점·이름·행동을 그리드 3열로 — 이름 폭이 달라도 버튼이 한 열에 정렬된다
  providerHeader: {
    display: 'grid',
    gridTemplateColumns: '8px 84px auto',
    alignItems: 'center',
    gap: 12,
    fontSize: 14,
    fontFamily: 'var(--font-prose-serif)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
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
  connectionBadge: {
    justifySelf: 'start',
    padding: '6px 12px',
    borderRadius: 999,
    background: 'var(--surface-container-low)',
    color: 'var(--on-surface-variant)',
    fontFamily: 'var(--font-ui-label)',
    fontSize: 12,
    fontWeight: 600,
  },
  credentialEditor: {
    margin: '10px 0 0 20px',
    padding: 12,
    borderRadius: 8,
    background: 'var(--surface-container-low)',
  },
  editorIntro: {
    margin: '0 0 10px',
    color: 'var(--on-surface-variant)',
    fontSize: 12,
    lineHeight: 1.5,
  },
  fieldGrid: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 9,
    flexWrap: 'wrap',
  },
  fieldLabel: {
    display: 'flex',
    minWidth: 170,
    flex: '1 1 220px',
    flexDirection: 'column',
    gap: 5,
    color: 'var(--on-surface-muted)',
    fontFamily: 'var(--font-ui-label)',
    fontSize: 11,
    fontWeight: 500,
  },
  fieldControl: {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    padding: '9px 10px',
    border: '1px solid transparent',
    borderRadius: 6,
    background: 'var(--surface-container-lowest)',
    color: 'var(--on-surface)',
    fontFamily: 'var(--font-ui-mono)',
    fontSize: 12,
  },
  editorFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
  },
  securityNote: {
    flex: 1,
    margin: 0,
    color: 'var(--on-surface-muted)',
    fontSize: 11,
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
    justifySelf: 'start',
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
