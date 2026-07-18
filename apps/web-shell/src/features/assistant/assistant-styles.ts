import type { CSSProperties } from 'react';
import type { ThreadMessage } from '@geulbat/protocol/threads';

/**
 * 우측 어시스턴트 visual reskin (§3.3.2) — Modern Heritage tokens.
 * 메커니즘은 carry, visual만 변경 (§3.3.1).
 */
export const assistantStyles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  transcript: {
    flex: 1,
    overflowY: 'auto',
    marginBottom: 8,
  },
  transcriptContent: {
    display: 'flex',
    flexDirection: 'column',
  },
  unreadNoticeRow: {
    display: 'flex',
    justifyContent: 'center',
    padding: '6px 0',
  },
  unreadNoticeButton: {
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--primary)',
    color: 'var(--on-primary)',
    border: 'none',
    borderRadius: 999,
    fontFamily: 'var(--font-ui-label)',
  },
  // user message — solid primary bubble (§3.3.2 #2)
  userMessageBlock: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    background: 'var(--primary)',
    color: 'var(--on-primary)',
    padding: '10px 14px',
    borderRadius: 8,
    borderTopRightRadius: 4,
    fontFamily: 'var(--font-ui-label)',
    fontSize: 13.5,
    lineHeight: 1.55,
    boxShadow: 'var(--elev-card)',
    margin: '4px 0',
  },
  // assistant text — 박스 없음, prose-serif. 작품 mode 영향 없음 (§10.24)
  assistantMessageBlock: {
    fontFamily: 'var(--font-prose-serif)',
    fontSize: 15,
    lineHeight: 1.7,
    color: 'var(--primary)',
    maxWidth: '92%',
    wordBreak: 'keep-all',
    margin: '4px 0',
  },
  messageRole: {
    fontSize: 10.5,
    color: 'var(--on-surface-muted)',
    marginBottom: 2,
    fontFamily: 'var(--font-ui-label)',
    letterSpacing: '0.03em',
  },
  messageText: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
  },
  commentaryBlock: {
    fontFamily: 'var(--font-prose-serif)',
    fontSize: 14,
    lineHeight: 1.65,
    color: 'var(--on-surface-variant)',
    maxWidth: '92%',
    wordBreak: 'keep-all',
    margin: '4px 0',
  },
  approvalNoticeBlock: {
    margin: '4px 0',
    padding: '10px 12px',
    borderRadius: 8,
    background: 'var(--warning-bg)',
    color: 'var(--warning-text)',
    fontSize: 13,
    fontFamily: 'var(--font-ui-label)',
  },
  approvalNoticeDetail: {
    marginTop: 4,
    fontSize: 11.5,
    color: 'var(--warning-text)',
    opacity: 0.85,
    lineHeight: 1.4,
    fontFamily: 'var(--font-ui-mono)',
    wordBreak: 'break-all',
  },
  errorBanner: {
    margin: '6px 0',
    padding: '10px 12px',
    borderRadius: 8,
    background: 'rgba(177, 74, 58, 0.1)',
    fontSize: 12.5,
    color: 'var(--error)',
    lineHeight: 1.5,
    fontFamily: 'var(--font-ui-label)',
  },
} satisfies Record<string, CSSProperties>;

export function getTranscriptMessageStyle(
  role: ThreadMessage['role'],
): CSSProperties {
  return role === 'user'
    ? assistantStyles.userMessageBlock
    : assistantStyles.assistantMessageBlock;
}
