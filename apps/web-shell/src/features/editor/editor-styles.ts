import type { CSSProperties } from 'react';

const editorAlertBase: CSSProperties = {
  padding: '8px 10px',
  borderRadius: 6,
  background: '#fff4e5',
  border: '1px solid #f6c26b',
  color: '#8a4b00',
  fontSize: 12,
  lineHeight: 1.45,
};

const editorButtonBase: CSSProperties = {
  fontSize: 12,
  cursor: 'pointer',
  borderRadius: 3,
};

export const editorStyles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  emptyState: {
    color: '#999',
    marginTop: 40,
    textAlign: 'center',
  },
  alert: {
    ...editorAlertBase,
    marginBottom: 12,
  },
  inlineAlert: {
    ...editorAlertBase,
    marginBottom: 8,
    flexShrink: 0,
  },
  headerBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    padding: '4px 0',
    borderBottom: '1px solid #eee',
    marginBottom: 8,
    flexShrink: 0,
  },
  pathLabel: {
    color: '#666',
    flex: 1,
  },
  conflictBanner: {
    background: '#fef7e0',
    border: '1px solid #f5c518',
    borderRadius: 4,
    padding: '8px 12px',
    marginBottom: 8,
    fontSize: 13,
    flexShrink: 0,
  },
  conflictActionRow: {
    marginTop: 6,
    display: 'flex',
    gap: 8,
  },
  textarea: {
    flex: 1,
    resize: 'none',
    border: 'none',
    outline: 'none',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 1.5,
    padding: 0,
    margin: 0,
    width: '100%',
  },
} satisfies Record<string, CSSProperties>;

export function getEditorSaveButtonStyle(enabled: boolean): CSSProperties {
  return {
    ...editorButtonBase,
    padding: '2px 10px',
    background: enabled ? '#1a73e8' : '#ccc',
    color: '#fff',
    border: 'none',
    opacity: enabled ? 1 : 0.5,
  };
}

export const editorConflictReloadButtonStyle: CSSProperties = {
  ...editorButtonBase,
  padding: '4px 12px',
  background: '#fff',
  border: '1px solid #ccc',
};

export const editorConflictForceSaveButtonStyle: CSSProperties = {
  ...editorButtonBase,
  padding: '4px 12px',
  background: '#d93025',
  color: '#fff',
  border: 'none',
};
