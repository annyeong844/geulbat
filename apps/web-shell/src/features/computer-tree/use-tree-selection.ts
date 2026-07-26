import {
  useCallback,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import type { FlatTreeRow } from './tree-flatten.js';

interface UseTreeSelectionArgs {
  rows: FlatTreeRow[];
  // 편집(생성/이름변경) 중에는 키보드 네비게이션을 무시한다.
  isEditing: boolean;
  activateRow: (row: FlatTreeRow) => void;
  toggleFolder: (path: string) => void;
  startRename: (path: string) => void;
  requestDelete: (path: string) => void;
}

interface TreeSelection {
  focusedPath: string | null;
  setFocusedPath: (path: string | null) => void;
  multiSelectedPaths: Set<string>;
  handleRowClick: (row: FlatTreeRow, event: MouseEvent) => void;
  handleTreeKeyDown: (event: KeyboardEvent) => void;
}

// 트리 행 포커스·다중 선택과 키보드 네비게이션. 키보드는 이동/펼침/활성화/이름
// 변경/삭제를 아우르는 dispatcher라 각 동작을 콜백으로 주입받는다. 포커스·선택
// 상태만 여기서 소유한다(펼침 상태는 트리 셸이 소유).
export function useTreeSelection({
  rows,
  isEditing,
  activateRow,
  toggleFolder,
  startRename,
  requestDelete,
}: UseTreeSelectionArgs): TreeSelection {
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [multiSelectedPaths, setMultiSelectedPaths] = useState<Set<string>>(
    new Set(),
  );

  const handleRowClick = useCallback(
    (row: FlatTreeRow, event: MouseEvent) => {
      setFocusedPath(row.node.path);
      // multi-select — selection visual + navigation까지만 (§3.1.2 / §10.16)
      if (event.metaKey || event.ctrlKey) {
        setMultiSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(row.node.path)) {
            next.delete(row.node.path);
          } else {
            next.add(row.node.path);
          }
          return next;
        });
        return;
      }
      if (event.shiftKey && focusedPath !== null) {
        const anchorIndex = rows.findIndex((r) => r.node.path === focusedPath);
        const targetIndex = rows.findIndex(
          (r) => r.node.path === row.node.path,
        );
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const [from, to] =
            anchorIndex <= targetIndex
              ? [anchorIndex, targetIndex]
              : [targetIndex, anchorIndex];
          setMultiSelectedPaths(
            new Set(rows.slice(from, to + 1).map((r) => r.node.path)),
          );
          return;
        }
      }
      setMultiSelectedPaths(new Set());
      activateRow(row);
    },
    [activateRow, focusedPath, rows],
  );

  const handleTreeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isEditing) {
        return;
      }
      const focusedIndex = rows.findIndex((r) => r.node.path === focusedPath);
      const focusedRow = focusedIndex >= 0 ? rows[focusedIndex] : undefined;

      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          const next = rows[Math.min(focusedIndex + 1, rows.length - 1)];
          if (next) {
            setFocusedPath(next.node.path);
          }
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          const next = rows[Math.max(focusedIndex - 1, 0)];
          if (next) {
            setFocusedPath(next.node.path);
          }
          break;
        }
        case 'ArrowRight': {
          event.preventDefault();
          if (focusedRow?.node.type === 'directory' && !focusedRow.isExpanded) {
            toggleFolder(focusedRow.node.path);
          }
          break;
        }
        case 'ArrowLeft': {
          event.preventDefault();
          if (focusedRow?.node.type === 'directory' && focusedRow.isExpanded) {
            toggleFolder(focusedRow.node.path);
          }
          break;
        }
        case 'Enter': {
          event.preventDefault();
          if (focusedRow) {
            activateRow(focusedRow);
          }
          break;
        }
        case 'F2': {
          event.preventDefault();
          if (focusedRow && focusedRow.node.type !== 'truncated') {
            startRename(focusedRow.node.path);
          }
          break;
        }
        case 'Delete': {
          event.preventDefault();
          if (focusedRow && focusedRow.node.type !== 'truncated') {
            requestDelete(focusedRow.node.path);
          }
          break;
        }
        default:
          break;
      }
    },
    [
      activateRow,
      focusedPath,
      isEditing,
      requestDelete,
      rows,
      startRename,
      toggleFolder,
    ],
  );

  return {
    focusedPath,
    setFocusedPath,
    multiSelectedPaths,
    handleRowClick,
    handleTreeKeyDown,
  };
}
