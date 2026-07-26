import type { ThreadSummary } from '@geulbat/protocol/threads';

import { sessionManagerStyles as styles } from './thread-list-styles.js';

interface Props {
  thread: ThreadSummary;
  isSelected: boolean;
  selectMode: boolean;
  isChecked: boolean;
  isRenaming: boolean;
  isConfirming: boolean;
  isMenuOpen: boolean;
  renameDraft: string;
  busy: boolean;
  onToggleChecked: () => void;
  onSelect: () => void;
  onToggleMenu: () => void;
  onStartRename: () => void;
  onStartConfirm: () => void;
  onTogglePin: () => void;
  onRenameDraftChange: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onConfirmDelete: () => void;
  onCancelConfirm: () => void;
}

function formatThreadDate(lastUpdated: string): string {
  const parsed = new Date(lastUpdated);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return `${parsed.getMonth() + 1}월 ${parsed.getDate()}일`;
}

// 세션 목록의 한 행 — 기본/인라인 이름변경/인라인 삭제확인 3개 모드와 ⋮ 메뉴를
// 그린다. 세션 상태는 소유하지 않고, 모드 플래그와 콜백만 받는 표현 컴포넌트다.
export function SessionRow({
  thread,
  isSelected,
  selectMode,
  isChecked,
  isRenaming,
  isConfirming,
  isMenuOpen,
  renameDraft,
  busy,
  onToggleChecked,
  onSelect,
  onToggleMenu,
  onStartRename,
  onStartConfirm,
  onTogglePin,
  onRenameDraftChange,
  onSubmitRename,
  onCancelRename,
  onConfirmDelete,
  onCancelConfirm,
}: Props) {
  return (
    <div
      className="session-manager-row"
      style={{
        position: 'relative',
        ...(isSelected ? { background: 'var(--surface-container)' } : {}),
        ...(selectMode ? { cursor: 'pointer' } : {}),
      }}
    >
      {selectMode ? (
        <button
          type="button"
          aria-pressed={isChecked}
          aria-label={`${thread.title ?? 'New Thread'} 선택`}
          onClick={onToggleChecked}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            border: 0,
            background: 'transparent',
            cursor: 'pointer',
          }}
        />
      ) : null}
      {selectMode ? (
        <input
          type="checkbox"
          checked={isChecked}
          readOnly
          aria-hidden="true"
          tabIndex={-1}
          style={{
            width: 17,
            height: 17,
            accentColor: 'var(--secondary)',
            // 히트박스는 행 전체 — 체크박스는 표시만 담당한다
            pointerEvents: 'none',
            flexShrink: 0,
          }}
        />
      ) : null}

      {isRenaming ? (
        <>
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onSubmitRename();
              }
              if (event.key === 'Escape') {
                onCancelRename();
              }
            }}
            aria-label="새 세션 이름"
            style={styles.renameInput}
          />
          <button
            type="button"
            style={styles.quietAction}
            disabled={busy}
            onClick={onSubmitRename}
          >
            저장
          </button>
          <button
            type="button"
            style={styles.quietAction}
            disabled={busy}
            onClick={onCancelRename}
          >
            취소
          </button>
        </>
      ) : isConfirming ? (
        <>
          <span style={styles.rowTitle}>{thread.title ?? 'New Thread'}</span>
          <span style={styles.rowMeta}>삭제할까요?</span>
          <button
            type="button"
            style={styles.dangerAction}
            disabled={busy}
            onClick={onConfirmDelete}
          >
            {busy ? '삭제 중…' : '삭제'}
          </button>
          <button
            type="button"
            style={styles.quietAction}
            disabled={busy}
            onClick={onCancelConfirm}
          >
            취소
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            style={styles.rowMain}
            aria-hidden={selectMode ? true : undefined}
            tabIndex={selectMode ? -1 : undefined}
            onClick={() => {
              if (selectMode) {
                // 행 onClick이 토글을 처리한다 — 이중 토글 방지
                return;
              }
              onSelect();
            }}
          >
            <div style={styles.rowTitle}>
              {thread.pinned === true ? '📌 ' : ''}
              {thread.title ?? 'New Thread'}
            </div>
          </button>
          <span
            className="row-date"
            style={styles.rowMeta}
            title={`${thread.messageCount}개 메시지`}
          >
            {formatThreadDate(thread.lastUpdated)}
          </span>
          {selectMode ? null : (
            <span style={{ position: 'relative' }}>
              <button
                type="button"
                className="row-menu-toggle"
                aria-label={`${thread.title ?? 'New Thread'} 메뉴`}
                aria-expanded={isMenuOpen}
                style={styles.quietAction}
                onClick={onToggleMenu}
              >
                ⋮
              </button>
              {isMenuOpen ? (
                <div className="session-manager-menu" role="menu">
                  <button type="button" onClick={onTogglePin}>
                    {thread.pinned === true ? '고정 해제' : '고정'}
                  </button>
                  <button type="button" onClick={onStartRename}>
                    이름 변경
                  </button>
                  <button type="button" onClick={onStartConfirm}>
                    <span style={{ color: 'var(--error)' }}>삭제</span>
                  </button>
                </div>
              ) : null}
            </span>
          )}
        </>
      )}
    </div>
  );
}
