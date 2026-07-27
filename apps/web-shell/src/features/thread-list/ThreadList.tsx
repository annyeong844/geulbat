import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadSummary } from '@geulbat/protocol/threads';
import {
  getThreadButtonStyle,
  threadListAlertStyle,
  threadListStyles,
} from './thread-list-styles.js';

export interface ThreadListProps {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  deletingThreadId?: string | null;
  exportingThreadId?: string | null;
  importingThreadArchive?: boolean;
  transferNotice?: string | null;
  uiError?: string | null;
  onLoad: () => Promise<void> | void;
  onSelect: (threadId: string) => Promise<void> | void;
  onDeleteRequest: (threadId: string) => Promise<void> | void;
  onExport?: (threadId: string) => Promise<void> | void;
  onImport?: (archive: Blob) => Promise<void> | void;
  // 있으면 목록 상단에 전체 관리 화면으로 나가는 확장 버튼을 그린다
  onOpenManager?: () => void;
  onRenameRequest?: (threadId: string, title: string) => Promise<void> | void;
  onTogglePin?: (threadId: string, pinned: boolean) => Promise<void> | void;
}

export function ThreadList({
  threads,
  selectedThreadId,
  deletingThreadId,
  exportingThreadId,
  importingThreadArchive = false,
  transferNotice,
  uiError,
  onLoad,
  onSelect,
  onDeleteRequest,
  onExport,
  onImport,
  onOpenManager,
  onRenameRequest,
  onTogglePin,
}: ThreadListProps) {
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [sortBy, setSortBy] = useState<'recent' | 'title' | 'messages'>(
    'recent',
  );

  useEffect(() => {
    void onLoad();
  }, [onLoad]);

  // 고정된 세션이 항상 위 — 그 안에서는 선택한 정렬 순서를 따른다
  const orderedThreads = useMemo(() => {
    const sorted = [...threads];
    if (sortBy === 'title') {
      sorted.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'ko'));
    } else if (sortBy === 'messages') {
      sorted.sort((a, b) => b.messageCount - a.messageCount);
    }
    const pinned = sorted.filter((thread) => thread.pinned === true);
    const rest = sorted.filter((thread) => thread.pinned !== true);
    return [...pinned, ...rest];
  }, [threads, sortBy]);

  const submitRename = async (threadId: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title !== '' && onRenameRequest !== undefined) {
      await onRenameRequest(threadId, title);
    }
  };

  return (
    <section className="thread-list" style={styles.section}>
      <div style={styles.managerRow}>
        {onOpenManager !== undefined ? (
          <button
            type="button"
            aria-label="세션 관리 열기"
            title="세션 관리"
            onClick={onOpenManager}
            style={styles.managerButton}
          >
            ↖
          </button>
        ) : null}
        {onImport !== undefined ? (
          <>
            {/* 옆의 세션 관리(↖)·정렬(⇅)과 같은 글리프 한 자. 이 줄에서 이
                버튼만 문장이면 두 이웃을 밀어내고 줄의 무게가 한쪽으로 쏠린다.
                진행 중이라는 사실은 사라지지 않는다 — 글자 대신 맥동으로
                남고, 이름은 title·aria-label이 계속 말한다. */}
            <button
              type="button"
              className={`thread-import-button${
                importingThreadArchive ? ' is-busy' : ''
              }`}
              aria-label={
                importingThreadArchive ? '대화 가져오는 중' : '대화 가져오기'
              }
              title={importingThreadArchive ? '가져오는 중…' : '대화 가져오기…'}
              aria-busy={importingThreadArchive}
              disabled={importingThreadArchive || exportingThreadId !== null}
              onClick={() => importInputRef.current?.click()}
              style={styles.managerButton}
            >
              ⤓
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              hidden
              onChange={(event) => {
                const archive = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (archive !== undefined) {
                  void onImport(archive);
                }
              }}
            />
          </>
        ) : null}
        <span className="thread-row-menu-anchor">
          <button
            type="button"
            aria-label="정렬"
            title="정렬"
            aria-expanded={sortMenuOpen}
            onClick={() => setSortMenuOpen((open) => !open)}
            style={styles.managerButton}
          >
            ⇅
          </button>
          {sortMenuOpen ? (
            <div className="session-manager-menu menu-left" role="menu">
              {(
                [
                  ['recent', '최근 활동순'],
                  ['title', '이름순'],
                  ['messages', '메시지 많은순'],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => {
                    setSortBy(value);
                    setSortMenuOpen(false);
                  }}
                >
                  <span>{label}</span>
                  {sortBy === value ? (
                    <span className="menu-check">✓</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      </div>
      {uiError ? (
        <div style={threadListAlertStyle} role="alert">
          {uiError}
        </div>
      ) : null}
      {transferNotice ? (
        <div style={threadListAlertStyle} role="status">
          {transferNotice}
        </div>
      ) : null}
      {orderedThreads.length === 0 ? (
        <p style={styles.emptyState}>
          아직 세션이 없습니다. + 버튼으로 새 세션을 시작하세요.
        </p>
      ) : (
        <ul style={styles.list}>
          {orderedThreads.map((t) => (
            <li key={t.threadId} className="thread-row">
              {renamingId === t.threadId ? (
                <div style={styles.row}>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void submitRename(t.threadId);
                      }
                      if (event.key === 'Escape') {
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() => void submitRename(t.threadId)}
                    aria-label="새 세션 이름"
                    style={styles.renameInput}
                  />
                </div>
              ) : (
                <div style={styles.row}>
                  <button
                    onClick={() => void onSelect(t.threadId)}
                    style={getThreadButtonStyle(
                      t.threadId === selectedThreadId,
                    )}
                  >
                    <div style={styles.threadTitle}>
                      {t.pinned === true ? '📌 ' : ''}
                      {t.title ?? 'New Thread'}
                    </div>
                    <div style={styles.threadMeta}>
                      {deletingThreadId === t.threadId
                        ? '삭제 중…'
                        : `${t.messageCount} messages`}
                    </div>
                  </button>
                  <span className="thread-row-menu-anchor">
                    <button
                      type="button"
                      className="thread-row-menu-button"
                      aria-label={`${t.title ?? 'New Thread'} 메뉴`}
                      aria-expanded={menuThreadId === t.threadId}
                      onClick={() =>
                        setMenuThreadId(
                          menuThreadId === t.threadId ? null : t.threadId,
                        )
                      }
                    >
                      ⋮
                    </button>
                    {menuThreadId === t.threadId ? (
                      <div className="session-manager-menu" role="menu">
                        {onTogglePin !== undefined ? (
                          <button
                            type="button"
                            onClick={() => {
                              setMenuThreadId(null);
                              void onTogglePin(t.threadId, t.pinned !== true);
                            }}
                          >
                            {t.pinned === true ? '고정 해제' : '고정'}
                          </button>
                        ) : null}
                        {onRenameRequest !== undefined ? (
                          <button
                            type="button"
                            onClick={() => {
                              setMenuThreadId(null);
                              setRenamingId(t.threadId);
                              setRenameDraft(t.title ?? '');
                            }}
                          >
                            이름 변경
                          </button>
                        ) : null}
                        {onExport !== undefined ? (
                          <button
                            type="button"
                            disabled={
                              importingThreadArchive ||
                              exportingThreadId !== null
                            }
                            onClick={() => {
                              setMenuThreadId(null);
                              void onExport(t.threadId);
                            }}
                          >
                            {exportingThreadId === t.threadId
                              ? '내보내는 중…'
                              : '대화 내보내기…'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            setMenuThreadId(null);
                            void onDeleteRequest(t.threadId);
                          }}
                        >
                          <span style={{ color: 'var(--error)' }}>삭제</span>
                        </button>
                      </div>
                    ) : null}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles = threadListStyles;
