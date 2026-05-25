import type { CSSProperties } from 'react';

export const providerAuthCardStyles = {
  section: {
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    padding: 12,
    background: '#fafafa',
  },
  description: {
    fontSize: 13,
    color: '#555',
    lineHeight: 1.5,
    marginBottom: 8,
  },
  alert: {
    marginBottom: 10,
    padding: '8px 10px',
    borderRadius: 6,
    background: '#fff4e5',
    border: '1px solid #f6c26b',
    color: '#8a4b00',
    fontSize: 12,
    lineHeight: 1.45,
  },
  statusRow: {
    fontSize: 12,
    color: '#777',
    marginBottom: 10,
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
} satisfies Record<string, CSSProperties>;

export function getProviderAuthButtonStyle(
  background: string,
  disabled: boolean,
): CSSProperties {
  return {
    padding: '6px 12px',
    fontSize: 13,
    cursor: disabled ? 'default' : 'pointer',
    background,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    opacity: disabled ? 0.5 : 1,
  };
}
