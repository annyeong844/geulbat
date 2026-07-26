import { useCallback, useState, type DragEvent } from 'react';

import type { ManageFileOperation } from '../../lib/api/files.js';
import { baseNameOf, parentDirOf } from '../../lib/path-name.js';
import type { FlatTreeRow } from './tree-flatten.js';

const TREE_DRAG_MIME = 'application/x-geulbat-tree-path';

interface UseTreeDragDropArgs {
  onManageEntry: (
    operation: ManageFileOperation,
    path: string,
    destination?: string,
  ) => Promise<boolean>;
  // 이동 성공을 사용자에게 알린다 (토스트는 트리 셸이 소유).
  showToast: (message: string) => void;
  // 옮긴 대상 폴더를 펼쳐 결과가 보이게 한다 (펼침 상태는 다른 관심사).
  expandDirectory: (directory: string) => void;
}

interface TreeDragDrop {
  dropTargetPath: string | null;
  handleDragStart: (row: FlatTreeRow, event: DragEvent) => void;
  handleDragOver: (row: FlatTreeRow, event: DragEvent) => void;
  handleDrop: (row: FlatTreeRow, event: DragEvent) => void;
  clearDropTarget: () => void;
}

// 트리 안 드래그앤드롭 이동(§3.1.2). 드롭 대상 하이라이트 상태를 소유하고, 유효한
// 드롭이면 onManageEntry('move')로 위임한다. 자기 폴더/자손/원위치로의 무의미한
// 이동은 막는다.
export function useTreeDragDrop({
  onManageEntry,
  showToast,
  expandDirectory,
}: UseTreeDragDropArgs): TreeDragDrop {
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const handleDragStart = useCallback((row: FlatTreeRow, event: DragEvent) => {
    event.dataTransfer.setData(TREE_DRAG_MIME, row.node.path);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((row: FlatTreeRow, event: DragEvent) => {
    if (
      row.node.type !== 'directory' ||
      !event.dataTransfer.types.includes(TREE_DRAG_MIME)
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetPath(row.node.path);
  }, []);

  const handleDrop = useCallback(
    (row: FlatTreeRow, event: DragEvent) => {
      event.preventDefault();
      setDropTargetPath(null);
      const source = event.dataTransfer.getData(TREE_DRAG_MIME);
      if (!source || row.node.type !== 'directory') {
        return;
      }
      const destinationDir = row.node.path;
      if (
        source === destinationDir ||
        destinationDir.startsWith(`${source}/`) ||
        parentDirOf(source) === destinationDir
      ) {
        return;
      }
      const destination = `${destinationDir}/${baseNameOf(source)}`;
      void onManageEntry('move', source, destination).then((moved) => {
        if (moved) {
          expandDirectory(destinationDir);
          showToast(`${baseNameOf(source)}을(를) 옮겼습니다.`);
        }
      });
    },
    [expandDirectory, onManageEntry, showToast],
  );

  const clearDropTarget = useCallback(() => setDropTargetPath(null), []);

  return {
    dropTargetPath,
    handleDragStart,
    handleDragOver,
    handleDrop,
    clearDropTarget,
  };
}
