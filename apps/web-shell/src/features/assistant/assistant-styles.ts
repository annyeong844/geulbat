import type { CSSProperties } from 'react';
import type { ThreadMessage } from '@geulbat/protocol/threads';

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
  unreadNoticeRow: {
    display: 'flex',
    justifyContent: 'center',
    padding: '6px 0',
  },
  unreadNoticeButton: {
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    background: '#174ea6',
    color: '#fff',
    border: 'none',
    borderRadius: 999,
  },
  messageBlock: {
    padding: '6px 8px',
    marginBottom: 4,
    borderRadius: 4,
    fontSize: 13,
  },
  messageRole: {
    fontSize: 11,
    color: '#888',
    marginBottom: 2,
  },
  messageText: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'inherit',
  },
  startingBlock: {
    padding: '6px 8px',
    marginBottom: 4,
    borderRadius: 4,
    background: '#fff8e1',
    fontSize: 13,
  },
  commentaryBlock: {
    padding: '6px 8px',
    marginBottom: 4,
    borderRadius: 4,
    background: '#f0f8e8',
    fontSize: 13,
  },
  activityBlock: {
    padding: '6px 8px',
    marginBottom: 4,
    borderRadius: 4,
    background: '#f5f7fb',
    border: '1px solid #d8e2f0',
    fontSize: 13,
  },
  activityText: {
    fontSize: 13,
    color: '#233245',
    lineHeight: 1.45,
  },
  approvalNoticeBlock: {
    padding: '6px 8px',
    marginBottom: 4,
    borderRadius: 4,
    background: '#fff8e1',
    border: '1px solid #f0c36d',
    fontSize: 13,
  },
  approvalNoticeDetail: {
    marginTop: 2,
    fontSize: 12,
    color: '#7a4d00',
    lineHeight: 1.4,
  },
  errorBanner: {
    padding: '8px 10px',
    marginBottom: 4,
    borderRadius: 4,
    background: '#fce8e6',
    border: '1px solid #d93025',
    fontSize: 13,
    color: '#c5221f',
  },
  backgroundNotification: {
    padding: '6px 8px',
    marginBottom: 4,
    borderRadius: 4,
    background: '#eef6ff',
    color: '#174ea6',
    fontSize: 13,
  },
  inputRow: {
    display: 'flex',
    gap: 4,
  },
  textarea: {
    flex: 1,
    resize: 'vertical',
    fontSize: 13,
    padding: 8,
    border: '1px solid #ccc',
    borderRadius: 4,
    fontFamily: 'inherit',
  },
  buttonColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  sendButton: {
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    background: '#1a73e8',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
  },
  cancelButton: {
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    background: '#d93025',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
  },
} satisfies Record<string, CSSProperties>;

export function getSendButtonStyle(disabled: boolean): CSSProperties {
  return {
    ...assistantStyles.sendButton,
    opacity: disabled ? 0.5 : 1,
  };
}

export function getTranscriptMessageStyle(
  role: ThreadMessage['role'],
): CSSProperties {
  return {
    ...assistantStyles.messageBlock,
    background: role === 'user' ? '#e8f0fe' : '#f5f5f5',
  };
}
