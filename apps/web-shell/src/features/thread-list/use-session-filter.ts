import { useMemo, useState } from 'react';
import type { ThreadSummary } from '@geulbat/protocol/threads';

interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

export type RecencyFilter = 'all' | 'today' | 'week';
export type Grouping = 'date' | 'none';

const DAY_MS = 24 * 60 * 60 * 1000;

// lastUpdated 기준 3단 구분 — 정밀한 달력 경계보다 훑기 좋은 묶음이 목적
function groupThreadsByRecency(
  threads: ThreadSummary[],
  now: number,
): ThreadGroup[] {
  const today: ThreadSummary[] = [];
  const week: ThreadSummary[] = [];
  const older: ThreadSummary[] = [];
  for (const thread of threads) {
    const updated = Date.parse(thread.lastUpdated);
    const age = Number.isNaN(updated) ? Infinity : now - updated;
    if (age < DAY_MS) {
      today.push(thread);
    } else if (age < 7 * DAY_MS) {
      week.push(thread);
    } else {
      older.push(thread);
    }
  }
  return [
    { label: '오늘', threads: today },
    { label: '지난 7일', threads: week },
    { label: '이전', threads: older },
  ].filter((group) => group.threads.length > 0);
}

interface SessionFilter {
  query: string;
  setQuery: (value: string) => void;
  recencyFilter: RecencyFilter;
  setRecencyFilter: (value: RecencyFilter) => void;
  grouping: Grouping;
  setGrouping: (value: Grouping) => void;
  selectMode: boolean;
  setSelectMode: (value: boolean) => void;
  checkedIds: ReadonlySet<string>;
  setCheckedIds: (value: ReadonlySet<string>) => void;
  toggleChecked: (threadId: string) => void;
  allVisibleChecked: boolean;
  toggleAllVisible: () => void;
  visibleThreads: ThreadSummary[];
  groups: ThreadGroup[];
}

// 세션 목록의 검색·기간필터·정렬·그룹화·다중선택 상태와 그로부터 파생되는
// 목록/그룹을 소유한다. 부작용(API 호출·refresh) 없이 순수 파생만 담당해
// SessionManagerOverlay의 렌더 책임과 분리한다.
export function useSessionFilter(threads: ThreadSummary[]): SessionFilter {
  const [query, setQuery] = useState('');
  const [recencyFilter, setRecencyFilter] = useState<RecencyFilter>('all');
  const [grouping, setGrouping] = useState<Grouping>('none');
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());

  const visibleThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const now = Date.now();
    const maxAge =
      recencyFilter === 'today'
        ? DAY_MS
        : recencyFilter === 'week'
          ? 7 * DAY_MS
          : Infinity;
    const filtered = threads.filter((thread) => {
      if (
        needle !== '' &&
        !(thread.title ?? '').toLowerCase().includes(needle)
      ) {
        return false;
      }
      if (maxAge !== Infinity) {
        const updated = Date.parse(thread.lastUpdated);
        if (Number.isNaN(updated) || now - updated >= maxAge) {
          return false;
        }
      }
      return true;
    });
    const sorted = [...filtered];
    sorted.sort(
      (a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated),
    );
    // 고정 세션은 항상 맨 위 (그 안에서는 최근 활동순 유지)
    return [
      ...sorted.filter((thread) => thread.pinned === true),
      ...sorted.filter((thread) => thread.pinned !== true),
    ];
  }, [threads, query, recencyFilter]);

  const groups = useMemo<ThreadGroup[]>(
    () =>
      grouping === 'date'
        ? groupThreadsByRecency(visibleThreads, Date.now())
        : visibleThreads.length > 0
          ? [{ label: '', threads: visibleThreads }]
          : [],
    [visibleThreads, grouping],
  );

  const toggleChecked = (threadId: string) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const allVisibleChecked =
    visibleThreads.length > 0 &&
    visibleThreads.every((thread) => checkedIds.has(thread.threadId));

  const toggleAllVisible = () => {
    setCheckedIds(
      allVisibleChecked
        ? new Set()
        : new Set(visibleThreads.map((thread) => thread.threadId)),
    );
  };

  return {
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
    visibleThreads,
    groups,
  };
}
