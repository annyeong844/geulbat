import { useEffect, useRef, type KeyboardEvent } from 'react';

import type { FlatTreeRow } from './tree-flatten.js';
import { isPlainTextInsertableFileName } from './tree-flatten.js';

export interface TreeContextMenuState {
  x: number;
  y: number;
  row: FlatTreeRow;
}

interface TreeContextMenuProps {
  menu: TreeContextMenuState;
  onClose: () => void;
  onCreateFile: (directoryPath: string) => void;
  onCreateFolder: (directoryPath: string) => void;
  onOpenFile: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onInsertIntoManuscript: (path: string) => void;
}

// right-click context menu (§3.1.2) — VSCode 탐색기 패턴
export function TreeContextMenu({
  menu,
  onClose,
  onCreateFile,
  onCreateFolder,
  onOpenFile,
  onRename,
  onDelete,
  onInsertIntoManuscript,
}: TreeContextMenuProps) {
  const { row, x, y } = menu;
  const isFolder = row.node.type === 'directory';
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) {
      return;
    }

    const focusedIndex = items.findIndex(
      (item) => item === document.activeElement,
    );
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = focusedIndex < 0 ? 0 : (focusedIndex + 1) % items.length;
        break;
      case 'ArrowUp':
        nextIndex =
          focusedIndex < 0
            ? items.length - 1
            : (focusedIndex - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = items.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {isFolder ? (
        <>
          <ContextMenuItem
            label="새 파일"
            onClick={() => onCreateFile(row.node.path)}
          />
          <ContextMenuItem
            label="새 폴더"
            onClick={() => onCreateFolder(row.node.path)}
          />
          <div className="context-menu-divider" />
          <ContextMenuItem
            label="이름 변경"
            hint="F2"
            onClick={() => onRename(row.node.path)}
          />
          <ContextMenuItem
            label="삭제"
            hint="Del"
            onClick={() => onDelete(row.node.path)}
          />
        </>
      ) : (
        <>
          <ContextMenuItem
            label="열기"
            onClick={() => onOpenFile(row.node.path)}
          />
          <ContextMenuItem
            label="이름 변경"
            hint="F2"
            onClick={() => onRename(row.node.path)}
          />
          <ContextMenuItem
            label="본문에 삽입"
            disabled={!isPlainTextInsertableFileName(row.node.name)}
            hint={
              isPlainTextInsertableFileName(row.node.name)
                ? undefined
                : '지원하지 않는 형식'
            }
            onClick={() => onInsertIntoManuscript(row.node.path)}
          />
          <div className="context-menu-divider" />
          <ContextMenuItem
            label="삭제"
            hint="Del"
            onClick={() => onDelete(row.node.path)}
          />
        </>
      )}
      <div className="context-menu-divider" />
      <ContextMenuItem label="닫기" onClick={onClose} />
    </div>
  );
}

function ContextMenuItem(props: {
  label: string;
  disabled?: boolean;
  hint?: string | undefined;
  onClick?: () => void;
}) {
  const { label, disabled = false, hint, onClick } = props;
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu-item"
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {hint ? <span className="context-menu-hint">{hint}</span> : null}
    </button>
  );
}
