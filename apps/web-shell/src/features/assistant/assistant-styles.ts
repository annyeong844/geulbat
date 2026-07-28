import type { CSSProperties } from 'react';
import type { ThreadMessage } from '@geulbat/protocol/threads';

/**
 * 우측 어시스턴트 visual reskin (§3.3.2) — Sage Editorial tokens.
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
    background: 'var(--secondary)',
    color: 'var(--on-primary)',
    border: 'none',
    borderRadius: 6,
    fontFamily: 'var(--font-ui-label)',
  },
  // user message — quiet sage bubble; the assistant remains the visual hero.
  userMessageBlock: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    background: 'var(--secondary-soft)',
    color: 'var(--on-secondary-fixed-variant)',
    padding: '10px 14px',
    border: '1px solid var(--outline-variant)',
    borderRadius: 10,
    borderTopRightRadius: 6,
    fontFamily: 'var(--font-ui-label)',
    fontSize: 13.5,
    lineHeight: 1.55,
    boxShadow: 'none',
    margin: '4px 0',
  },
  // assistant text — 박스 없음, prose-serif. 작품 mode 영향 없음 (§10.24)
  assistantMessageBlock: {
    fontFamily: 'var(--font-prose-serif)',
    fontSize: 15.5,
    lineHeight: 1.75,
    color: 'var(--primary)',
    maxWidth: '100%',
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
  // 채팅 속 승인 기록 줄 — 도구 타임라인과 같은 무게의 조용한 로그.
  // 행동 유도는 컴포저 위 승인 카드(.approval-card)가 owner다.
  approvalNoticeBlock: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    margin: '4px 0',
    padding: '4px 6px',
    color: 'var(--on-surface-muted)',
    fontSize: 12,
    fontFamily: 'var(--font-ui-label)',
  },
  // 라벨은 줄지 않는다. flex 자식은 기본으로 줄어들고 한글은 글자 사이에서
  // 줄바꿈되므로, 옆의 `nowrap` 명령문과 폭을 다투면 "승 / 인 / 요 / 청"처럼
  // 세로로 무너진다. 줄어드는 쪽은 ellipsis를 가진 detail이어야 한다.
  approvalNoticeLabel: {
    flex: 'none',
    whiteSpace: 'nowrap',
  },
  approvalNoticeDetail: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11.5,
    color: 'var(--on-surface-muted)',
    fontFamily: 'var(--font-ui-mono)',
  },
  errorBanner: {
    margin: '6px 0',
    padding: '10px 12px',
    border: '1px solid color-mix(in srgb, var(--error) 22%, transparent)',
    borderRadius: 10,
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
