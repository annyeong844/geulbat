import type { CSSProperties } from 'react';

export const artifactPaneStyles = {
  plainMessage: {
    padding: '10px 12px',
    marginBottom: 8,
    borderRadius: 12,
    background:
      'linear-gradient(180deg, rgba(255,248,234,0.96) 0%, rgba(247,242,230,0.98) 100%)',
    border: '1px solid #e0d3b9',
    boxShadow: '0 8px 18px rgba(88, 67, 32, 0.08)',
    fontSize: 13,
  },
  plainMessageText: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'inherit',
  },
  container: {
    padding: '12px 14px',
    marginBottom: 10,
    borderRadius: 16,
    background:
      'linear-gradient(180deg, rgba(255,248,234,0.98) 0%, rgba(247,241,228,0.98) 100%)',
    border: '1px solid #d6c4a2',
    boxShadow: '0 10px 24px rgba(95, 71, 28, 0.1)',
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
    color: '#6d6253',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
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
    background: 'rgba(255, 255, 255, 0.68)',
    border: '1px solid rgba(183, 156, 108, 0.42)',
    fontSize: 11,
    color: '#705f47',
    lineHeight: 1.2,
  },
  buttonRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  exportForm: {
    display: 'grid',
    gap: 8,
    marginBottom: 12,
    padding: '12px',
    borderRadius: 12,
    background: 'rgba(255, 252, 244, 0.88)',
    border: '1px solid #e1d4b7',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.72)',
  },
  exportInput: {
    width: '100%',
    padding: '9px 10px',
    borderRadius: 10,
    border: '1px solid #c8baa0',
    fontSize: 12,
    background: 'rgba(255,255,255,0.94)',
  },
  exportActions: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  exportHint: {
    fontSize: 11,
    color: '#6d6253',
    lineHeight: 1.45,
  },
  fallbackBanner: {
    padding: '8px 10px',
    marginBottom: 12,
    borderRadius: 10,
    background: '#fce8e6',
    color: '#c5221f',
    border: '1px solid #d93025',
    fontSize: 12,
  },
  previewContainer: {
    padding: '14px',
    background:
      'linear-gradient(180deg, rgba(255,255,253,0.92) 0%, rgba(255,251,243,0.96) 100%)',
    border: '1px solid #e3d8bf',
    borderRadius: 14,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.85)',
  },
  runtimeUnavailableBody: {
    color: '#6d6253',
    fontSize: 12,
    lineHeight: 1.55,
  },
  runtimeUnavailableDetail: {
    display: 'block',
    marginTop: 8,
    color: '#8a2b27',
    fontSize: 11,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  },
  previewPendingBody: {
    display: 'grid',
    gap: 8,
    minHeight: 180,
    alignContent: 'center',
    justifyItems: 'center',
    color: '#6d6253',
    fontSize: 12,
    lineHeight: 1.55,
    textAlign: 'center',
  },
  body: {
    margin: 0,
    padding: '14px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: '1px solid #e3d8bf',
    borderRadius: 14,
  },
  richBody: {
    background:
      'linear-gradient(180deg, rgba(255,255,253,0.92) 0%, rgba(255,251,243,0.96) 100%)',
    fontFamily: 'inherit',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.85)',
  },
  rawBody: {
    background: '#fff',
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  },
  tabButton: {
    padding: '5px 10px',
    borderRadius: 999,
    border: '1px solid #c8baa0',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    boxShadow: '0 1px 0 rgba(255,255,255,0.7)',
  },
} satisfies Record<string, CSSProperties>;

export function getArtifactBodyStyle(
  tab: 'write' | 'show' | 'raw',
): CSSProperties {
  return {
    ...artifactPaneStyles.body,
    ...(tab === 'raw'
      ? artifactPaneStyles.rawBody
      : artifactPaneStyles.richBody),
  };
}

export function getTabButtonStyle(
  active: boolean,
  disabled: boolean,
): CSSProperties {
  return {
    ...artifactPaneStyles.tabButton,
    background: active
      ? 'linear-gradient(180deg, #c89b45 0%, #a97829 100%)'
      : 'rgba(255, 252, 244, 0.92)',
    color: active ? '#fffef8' : '#6d6253',
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'default' : 'pointer',
  };
}

export function getStateBadgeStyle(tone: 'info' | 'warn'): CSSProperties {
  const palette =
    tone === 'info'
      ? {
          background: 'rgba(42, 111, 166, 0.12)',
          borderColor: 'rgba(42, 111, 166, 0.24)',
          color: '#28527a',
        }
      : {
          background: 'rgba(197, 34, 31, 0.1)',
          borderColor: 'rgba(197, 34, 31, 0.22)',
          color: '#8a2b27',
        };
  return {
    ...artifactPaneStyles.metaBadge,
    ...palette,
  };
}

export function getInlineActionButtonStyle(enabled: boolean): CSSProperties {
  return {
    padding: '7px 10px',
    borderRadius: 10,
    border: '1px solid #c8baa0',
    background: 'rgba(255,255,255,0.94)',
    color: '#6d6253',
    fontSize: 12,
    fontWeight: 600,
    opacity: enabled ? 1 : 0.45,
    cursor: enabled ? 'pointer' : 'default',
  };
}
