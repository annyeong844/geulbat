import type { CSSProperties } from 'react';

/**
 * artifact card — Modern Heritage (§3.3.2 #6/#7).
 * 색상 리터럴 금지: App.css 토큰(var(--...))만 참조한다.
 */
export const artifactPaneStyles = {
  container: {
    padding: '12px 14px',
    marginBottom: 10,
    borderRadius: 16,
    background: 'var(--surface-container-lowest)',
    boxShadow: 'var(--elev-card)',
    fontSize: 13,
    position: 'relative',
    overflow: 'hidden',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  headerCopy: {
    display: 'grid',
    gap: 5,
    minWidth: 0,
  },
  label: {
    fontSize: 11,
    color: 'var(--on-surface-muted)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontFamily: 'var(--font-ui-label)',
  },
  metaRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  metaBadge: {
    padding: '3px 8px',
    borderRadius: 999,
    fontSize: 11,
    lineHeight: 1.2,
    fontFamily: 'var(--font-ui-label)',
  },
  // 알약 배경을 버튼 개별로 두지 않고 줄 전체에 씌우면 줄바꿈 시 모양이
  // 깨진다 — 컨테이너는 투명하게 두고 버튼이 각자 상태 배경을 가진다.
  buttonRow: {
    display: 'flex',
    gap: 2,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  exportForm: {
    display: 'grid',
    gap: 8,
    marginBottom: 12,
    padding: '12px',
    borderRadius: 8,
    background: 'var(--surface-container-low)',
  },
  exportInput: {
    width: '100%',
    padding: '9px 10px',
    borderRadius: 4,
    border: 'none',
    borderBottom: '1px solid rgba(50, 34, 20, 0.2)',
    fontSize: 12,
    background: 'var(--surface-container-lowest)',
    color: 'var(--on-surface)',
    fontFamily: 'var(--font-ui-label)',
    outline: 'none',
  },
  exportActions: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  exportHint: {
    fontSize: 11,
    color: 'var(--on-surface-muted)',
    lineHeight: 1.45,
  },
  fallbackBanner: {
    padding: '8px 10px',
    marginBottom: 12,
    borderRadius: 8,
    background: 'rgba(177, 74, 58, 0.1)',
    color: 'var(--error)',
    fontSize: 12,
  },
  previewContainer: {
    padding: '14px',
    background: 'var(--surface-container-low)',
    borderRadius: 8,
  },
  runtimeUnavailableBody: {
    color: 'var(--on-surface-muted)',
    fontSize: 12,
    lineHeight: 1.55,
  },
  runtimeUnavailableDetail: {
    display: 'block',
    marginTop: 8,
    color: 'var(--error)',
    fontSize: 11,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--font-ui-mono)',
  },
  previewPendingBody: {
    display: 'grid',
    gap: 8,
    minHeight: 180,
    alignContent: 'center',
    justifyItems: 'center',
    color: 'var(--on-surface-muted)',
    fontSize: 12,
    lineHeight: 1.55,
    textAlign: 'center',
  },
  body: {
    margin: 0,
    padding: '14px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    borderRadius: 8,
  },
  richBody: {
    background: 'var(--surface-container-low)',
    fontFamily: 'var(--font-prose-serif)',
    color: 'var(--on-surface-variant)',
    lineHeight: 1.6,
  },
  rawBody: {
    background: 'var(--surface-container-low)',
    fontFamily: 'var(--font-ui-mono)',
    color: 'var(--on-surface-variant)',
  },
  tabButton: {
    padding: '4px 10px',
    borderRadius: 999,
    border: 'none',
    cursor: 'pointer',
    fontSize: 11.5,
    fontWeight: 500,
    fontFamily: 'var(--font-ui-label)',
    transition: 'all var(--transition-base)',
  },
} satisfies Record<string, CSSProperties>;

export function getArtifactBodyStyle(tab: 'show' | 'source'): CSSProperties {
  return {
    ...artifactPaneStyles.body,
    ...(tab === 'source'
      ? artifactPaneStyles.rawBody
      : artifactPaneStyles.richBody),
  };
}

// 토글: active = secondary-soft pill, inactive = ghost (§3.3.2 #7)
export function getTabButtonStyle(
  active: boolean,
  disabled: boolean,
): CSSProperties {
  return {
    ...artifactPaneStyles.tabButton,
    background: active ? 'var(--secondary-soft)' : 'transparent',
    color: active
      ? 'var(--on-secondary-fixed-variant)'
      : 'var(--on-surface-muted)',
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'default' : 'pointer',
  };
}

export function getStateBadgeStyle(tone: 'info' | 'warn'): CSSProperties {
  const palette =
    tone === 'info'
      ? {
          background: 'var(--secondary-soft)',
          color: 'var(--on-secondary-fixed-variant)',
        }
      : {
          background: 'var(--warning-bg)',
          color: 'var(--warning-text)',
        };
  return {
    ...artifactPaneStyles.metaBadge,
    ...palette,
  };
}

export function getInlineActionButtonStyle(enabled: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--surface-container)',
    color: 'var(--on-surface-variant)',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'var(--font-ui-label)',
    opacity: enabled ? 1 : 0.45,
    cursor: enabled ? 'pointer' : 'default',
  };
}
