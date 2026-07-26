import { useState } from 'react';
import type { ThreadSummary } from '@geulbat/protocol/threads';

import { sessionManagerStyles as styles } from './thread-list-styles.js';
import { SessionDeleteDialog } from './SessionDeleteDialog.js';
import { SessionManagerToolbar } from './SessionManagerToolbar.js';
import { SessionRow } from './SessionRow.js';
import { useSessionFilter } from './use-session-filter.js';
import { useSessionMutations } from './use-session-mutations.js';

interface Props {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  onClose: () => void;
  onSelect: (threadId: string) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  // 열려 있던 세션이 삭제됐을 때 셸이 빈 세션으로 복귀할 수 있게 한다
  onSelectedThreadDeleted: () => void;
  onNewSession?: () => void;
}

type OpenMenu = 'filter' | 'sort' | { rowId: string } | null;

export function SessionManagerOverlay({
  threads,
  selectedThreadId,
  onClose,
  onSelect,
  onRefresh,
  onSelectedThreadDeleted,
  onNewSession,
}: Props) {
  const {
    query,
    setQuery,
    recencyFilter,
    setRecencyFilter,
    grouping,
    setGrouping,
    selectMode,
    setSelectMode,
    checkedIds,
    setCheckedIds,
    toggleChecked,
    allVisibleChecked,
    toggleAllVisible,
    groups,
  } = useSessionFilter(threads);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);

  const rowMenuId =
    openMenu !== null && typeof openMenu === 'object' ? openMenu.rowId : null;

  const { busy, notice, deleteThreads, submitRename, togglePin } =
    useSessionMutations({
      selectedThreadId,
      onRefresh,
      onSelectedThreadDeleted,
      clearSelection: () => {
        setCheckedIds(new Set());
        setConfirmingBulk(false);
        setConfirmingId(null);
      },
      closeRename: () => setRenamingId(null),
    });

  return (
    <section className="home-sessions" aria-label="세션 관리">
      <header className="session-manager-header">
        <button
          type="button"
          className="settings-close"
          aria-label="세션 관리 닫기"
          title="편집기로 돌아가기"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <SessionManagerToolbar
        selectMode={selectMode}
        allVisibleChecked={allVisibleChecked}
        checkedCount={checkedIds.size}
        recencyFilter={recencyFilter}
        grouping={grouping}
        filterMenuOpen={openMenu === 'filter'}
        onEnterSelect={() => {
          setSelectMode(true);
          setCheckedIds(new Set());
          setConfirmingBulk(false);
          setOpenMenu(null);
        }}
        onExitSelect={() => {
          setSelectMode(false);
          setCheckedIds(new Set());
          setConfirmingBulk(false);
        }}
        onToggleAll={toggleAllVisible}
        onBulkDelete={() => setConfirmingBulk(true)}
        onToggleFilterMenu={() =>
          setOpenMenu(openMenu === 'filter' ? null : 'filter')
        }
        onCloseMenu={() => setOpenMenu(null)}
        onPickRecency={setRecencyFilter}
        onPickGrouping={setGrouping}
        {...(onNewSession !== undefined ? { onNewSession } : {})}
      />

      <div className="session-manager-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="세션 검색…"
          aria-label="세션 검색"
          style={styles.search}
        />
      </div>

      {notice ? (
        <p role="alert" style={styles.groupLabel}>
          {notice}
        </p>
      ) : null}

      <div className="session-manager-list">
        {groups.length === 0 ? (
          <p style={styles.groupLabel}>
            {query.trim() === '' && recencyFilter === 'all'
              ? '아직 세션이 없습니다.'
              : '조건과 일치하는 세션이 없습니다.'}
          </p>
        ) : null}

        {groups.map((group) => (
          <section
            key={group.label || 'all'}
            aria-label={group.label || '세션'}
          >
            {group.label ? (
              <p style={styles.groupLabel}>{group.label}</p>
            ) : null}
            {group.threads.map((thread) => (
              <SessionRow
                key={thread.threadId}
                thread={thread}
                isSelected={thread.threadId === selectedThreadId}
                selectMode={selectMode}
                isChecked={checkedIds.has(thread.threadId)}
                isRenaming={renamingId === thread.threadId}
                isConfirming={confirmingId === thread.threadId}
                isMenuOpen={rowMenuId === thread.threadId}
                renameDraft={renameDraft}
                busy={busy}
                onToggleChecked={() => toggleChecked(thread.threadId)}
                onSelect={() => void onSelect(thread.threadId)}
                onToggleMenu={() =>
                  setOpenMenu(
                    rowMenuId === thread.threadId
                      ? null
                      : { rowId: thread.threadId },
                  )
                }
                onStartRename={() => {
                  setRenamingId(thread.threadId);
                  setRenameDraft(thread.title ?? '');
                  setOpenMenu(null);
                }}
                onStartConfirm={() => {
                  setConfirmingId(thread.threadId);
                  setOpenMenu(null);
                }}
                onTogglePin={() => {
                  setOpenMenu(null);
                  void togglePin(thread);
                }}
                onRenameDraftChange={setRenameDraft}
                onSubmitRename={() =>
                  void submitRename(thread.threadId, renameDraft)
                }
                onCancelRename={() => setRenamingId(null)}
                onConfirmDelete={() => void deleteThreads([thread.threadId])}
                onCancelConfirm={() => setConfirmingId(null)}
              />
            ))}
          </section>
        ))}
      </div>

      {confirmingBulk ? (
        <SessionDeleteDialog
          count={checkedIds.size}
          busy={busy}
          onCancel={() => setConfirmingBulk(false)}
          onConfirm={() => void deleteThreads([...checkedIds])}
        />
      ) : null}
    </section>
  );
}
