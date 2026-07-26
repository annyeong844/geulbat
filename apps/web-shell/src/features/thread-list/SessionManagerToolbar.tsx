import { sessionManagerStyles as styles } from './thread-list-styles.js';
import type { Grouping, RecencyFilter } from './use-session-filter.js';

interface Props {
  selectMode: boolean;
  allVisibleChecked: boolean;
  checkedCount: number;
  recencyFilter: RecencyFilter;
  grouping: Grouping;
  filterMenuOpen: boolean;
  onEnterSelect: () => void;
  onExitSelect: () => void;
  onToggleAll: () => void;
  onBulkDelete: () => void;
  onToggleFilterMenu: () => void;
  onCloseMenu: () => void;
  onPickRecency: (value: RecencyFilter) => void;
  onPickGrouping: (value: Grouping) => void;
  onNewSession?: () => void;
}

// 세션 관리 상단 컨트롤 — 기본(선택/필터/새로 생성)과 선택 모드(전체선택/삭제/
// 돌아가기)를 그린다. 세션 상태는 소유하지 않고 플래그·콜백만 받는다.
export function SessionManagerToolbar({
  selectMode,
  allVisibleChecked,
  checkedCount,
  recencyFilter,
  grouping,
  filterMenuOpen,
  onEnterSelect,
  onExitSelect,
  onToggleAll,
  onBulkDelete,
  onToggleFilterMenu,
  onCloseMenu,
  onPickRecency,
  onPickGrouping,
  onNewSession,
}: Props) {
  const menuChoice = (label: string, active: boolean, onPick: () => void) => (
    <button
      type="button"
      key={label}
      onClick={() => {
        onPick();
        onCloseMenu();
      }}
    >
      <span>{label}</span>
      {active ? <span className="menu-check">✓</span> : null}
    </button>
  );

  return (
    <div className="session-manager-controls-row">
      <div className="session-manager-header-controls">
        {selectMode ? (
          <>
            <button
              type="button"
              style={styles.headerButton}
              onClick={onToggleAll}
            >
              {allVisibleChecked ? '전체 해제' : '전체 선택'}
            </button>
            <button
              type="button"
              style={styles.dangerButton}
              disabled={checkedCount === 0}
              onClick={onBulkDelete}
            >
              삭제
            </button>
            <button
              type="button"
              style={styles.headerButton}
              onClick={onExitSelect}
            >
              돌아가기
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              style={styles.headerButton}
              aria-pressed={selectMode}
              onClick={onEnterSelect}
            >
              선택
            </button>
            <span style={{ position: 'relative' }}>
              <button
                type="button"
                style={styles.headerButton}
                aria-label="필터"
                aria-expanded={filterMenuOpen}
                onClick={onToggleFilterMenu}
              >
                필터 기준{' '}
                {recencyFilter === 'all'
                  ? '전체'
                  : recencyFilter === 'today'
                    ? '오늘'
                    : '지난 7일'}{' '}
                ▾
              </button>
              {filterMenuOpen ? (
                <div className="session-manager-menu" role="menu">
                  <span className="menu-section">마지막 활동</span>
                  {menuChoice('전체', recencyFilter === 'all', () =>
                    onPickRecency('all'),
                  )}
                  {menuChoice('오늘', recencyFilter === 'today', () =>
                    onPickRecency('today'),
                  )}
                  {menuChoice('지난 7일', recencyFilter === 'week', () =>
                    onPickRecency('week'),
                  )}
                  <span className="menu-section">그룹화 기준</span>
                  {menuChoice('날짜별', grouping === 'date', () =>
                    onPickGrouping('date'),
                  )}
                  {menuChoice('없음', grouping === 'none', () =>
                    onPickGrouping('none'),
                  )}
                </div>
              ) : null}
            </span>
            {onNewSession !== undefined ? (
              <button
                type="button"
                style={styles.primaryButton}
                onClick={onNewSession}
              >
                새로 생성
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
