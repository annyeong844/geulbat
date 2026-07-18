import { useEffect } from 'react';
import type { ThreadSummary } from '@geulbat/protocol/threads';
import {
  getThreadButtonStyle,
  threadDeleteButtonStyle,
  threadListAlertStyle,
  threadListStyles,
} from './thread-list-styles.js';

interface Props {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  deletingThreadId?: string | null;
  uiError?: string | null;
  onLoad: () => Promise<void> | void;
  onSelect: (threadId: string) => Promise<void> | void;
  onDeleteRequest: (threadId: string) => Promise<void> | void;
}

export function ThreadList({
  threads,
  selectedThreadId,
  deletingThreadId,
  uiError,
  onLoad,
  onSelect,
  onDeleteRequest,
}: Props) {
  useEffect(() => {
    void onLoad();
  }, [onLoad]);

  return (
    <section className="thread-list" style={styles.section}>
      {uiError ? (
        <div style={threadListAlertStyle} role="alert">
          {uiError}
        </div>
      ) : null}
      {threads.length === 0 ? (
        <p style={styles.emptyState}>
          아직 세션이 없습니다. + 버튼으로 새 세션을 시작하세요.
        </p>
      ) : (
        <ul style={styles.list}>
          {threads.map((t) => (
            <li key={t.threadId}>
              <div style={styles.row}>
                <button
                  onClick={() => void onSelect(t.threadId)}
                  style={getThreadButtonStyle(t.threadId === selectedThreadId)}
                >
                  <div style={styles.threadTitle}>
                    {t.title ?? 'New Thread'}
                  </div>
                  <div style={styles.threadMeta}>{t.messageCount} messages</div>
                </button>
                <button
                  aria-label={`Delete thread ${t.title ?? t.threadId}`}
                  disabled={deletingThreadId === t.threadId}
                  onClick={() => void onDeleteRequest(t.threadId)}
                  style={threadDeleteButtonStyle}
                >
                  {deletingThreadId === t.threadId ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles = threadListStyles;
