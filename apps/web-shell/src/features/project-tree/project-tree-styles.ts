import type { CSSProperties } from 'react';

export const projectTreeAlertStyle: CSSProperties = {
  marginBottom: 10,
  padding: '8px 10px',
  borderRadius: 6,
  background: '#fff4e5',
  border: '1px solid #f6c26b',
  color: '#8a4b00',
  fontSize: 12,
  lineHeight: 1.45,
};

export const projectTreeStyles = {
  emptyState: {
    fontSize: 13,
    color: '#999',
  },
  treeList: {
    listStyle: 'none',
    margin: 0,
  },
  directorySummary: {
    cursor: 'pointer',
    fontSize: 13,
    padding: '2px 0',
  },
  fileButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    padding: '2px 0',
    color: '#333',
    textAlign: 'left',
  },
} satisfies Record<string, CSSProperties>;

export function getProjectTreeListStyle(depth: number): CSSProperties {
  return {
    ...projectTreeStyles.treeList,
    paddingLeft: depth > 0 ? 14 : 0,
  };
}
