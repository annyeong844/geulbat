import type { CSSProperties } from 'react';

export function getThreadButtonStyle(isSelected: boolean): CSSProperties {
  return {
    background: isSelected ? '#e8f0fe' : 'none',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
    fontSize: 13,
    padding: '4px 6px',
    borderRadius: 4,
  };
}

export const threadListAlertStyle: CSSProperties = {
  marginBottom: 10,
  padding: '8px 10px',
  borderRadius: 6,
  background: '#fff4e5',
  border: '1px solid #f6c26b',
  color: '#8a4b00',
  fontSize: 12,
  lineHeight: 1.45,
};

export const threadDeleteButtonStyle: CSSProperties = {
  marginTop: 4,
  borderRadius: 4,
  border: '1px solid #d7b3b3',
  background: '#fff5f5',
  color: '#8a2f2f',
  fontSize: 11,
  lineHeight: 1.2,
  padding: '4px 6px',
  cursor: 'pointer',
  flexShrink: 0,
};

export const threadListStyles = {
  section: {
    marginTop: 16,
  },
  emptyState: {
    fontSize: 13,
    color: '#999',
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
  },
  threadMeta: {
    fontSize: 11,
    color: '#888',
  },
} satisfies Record<string, CSSProperties>;
