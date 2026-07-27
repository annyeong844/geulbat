import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import type { FileTreeNode } from '@geulbat/protocol/files';

import type { ManageFileOperation } from '../../lib/api/files.js';
import { baseNameOf, buildPathBreadcrumbs } from '../../lib/path-name.js';
import {
  flattenVisibleTree,
  isCanvasEligibleFileName,
  type FlatTreeRow,
} from './tree-flatten.js';
import {
  TreeContextMenu,
  type TreeContextMenuState,
} from './TreeContextMenu.js';
import { useTreeDragDrop } from './use-tree-drag-drop.js';
import { useTreeMutations } from './use-tree-mutations.js';
import { useTreeSelection } from './use-tree-selection.js';
import { useTreeVirtualScroll } from './use-tree-virtual-scroll.js';

export interface ComputerTreeProps {
  tree: FileTreeNode[];
  uiError?: string | null;
  selectedPath?: string | null;
  browseEnabled?: boolean;
  browsePath?: string;
  browseStartPath?: string;
  browseShortcuts?: Array<{ label: string; path: string }>;
  /** 사용자가 직접 고정한 폴더 — 자동 발견 경로보다 먼저 보인다. */
  favoriteDirectories?: ReadonlyArray<{ path: string }>;
  onNavigateUp?: () => void;
  onNavigateInto?: (path: string) => void;
  onLoad: () => Promise<void> | void;
  onLoadSubtree?: (path: string) => Promise<void> | void;
  onSelect: (path: string) => Promise<void> | void;
  onCreateFile: (path: string) => Promise<boolean>;
  onManageEntry: (
    operation: ManageFileOperation,
    path: string,
    destination?: string,
  ) => Promise<boolean>;
  onInsertIntoManuscript?: (path: string) => Promise<void> | void;
}

type QuickAccessIconKind = 'home' | 'computer' | 'drive' | 'folder';

const TREE_ROW_HEIGHT = 32;

/**
 * 좌측 탐색기 — VSCode/윈도우 탐색기 패턴의 user file ops shell input path
 * (§3.1). mutation semantics는 daemon owner이며, 모든 ops는 agent tool과
 * 같은 daemon mutation chain을 거친다 (§3.1.5).
 */
export function ComputerTree({
  tree,
  uiError,
  selectedPath = null,
  browseEnabled = false,
  browsePath = '',
  browseStartPath = '',
  browseShortcuts = [],
  favoriteDirectories = [],
  onNavigateUp,
  onNavigateInto,
  onLoad,
  onLoadSubtree,
  onSelect,
  onCreateFile,
  onManageEntry,
  onInsertIntoManuscript,
}: ComputerTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(
    null,
  );
  const [shellToast, setShellToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void onLoad();
  }, [onLoad]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const rows = useMemo(
    () => flattenVisibleTree(tree, expandedPaths),
    [tree, expandedPaths],
  );

  const { treeScrollRef, visibleWindow, handleTreeScroll } =
    useTreeVirtualScroll(rows, TREE_ROW_HEIGHT);

  const showShellToast = useCallback((message: string) => {
    setShellToast(message);
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => setShellToast(null), 5000);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // lazy 트리: 펼쳐진 폴더의 children이 아직 없으면 하위 트리를 요청한다
  const pendingSubtreeRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!onLoadSubtree) {
      return;
    }
    for (const row of rows) {
      if (
        row.node.type === 'directory' &&
        row.isExpanded &&
        row.node.children === undefined &&
        !pendingSubtreeRef.current.has(row.node.path)
      ) {
        pendingSubtreeRef.current.add(row.node.path);
        void Promise.resolve(onLoadSubtree(row.node.path)).finally(() => {
          pendingSubtreeRef.current.delete(row.node.path);
        });
      }
    }
  });

  const activateRow = useCallback(
    (row: FlatTreeRow) => {
      if (row.node.type === 'directory') {
        toggleFolder(row.node.path);
      } else if (row.node.type === 'file') {
        void onSelect(row.node.path);
      }
    },
    [onSelect, toggleFolder],
  );

  const expandDirectory = useCallback((directory: string) => {
    setExpandedPaths((prev) => new Set(prev).add(directory));
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const {
    creating,
    createName,
    setCreateName,
    renamingPath,
    renameValue,
    setRenameValue,
    confirmDeletePath,
    setConfirmDeletePath,
    editInputRef,
    startCreate,
    commitCreate,
    cancelCreate,
    startRename,
    commitRename,
    cancelRename,
    requestDelete,
    commitDelete,
  } = useTreeMutations({
    onCreateFile,
    onManageEntry,
    showToast: showShellToast,
    closeContextMenu,
    expandDirectory,
  });

  const handleInsertIntoManuscript = useCallback(
    (path: string) => {
      closeContextMenu();
      if (onInsertIntoManuscript) {
        void onInsertIntoManuscript(path);
      } else {
        showShellToast('열린 문서가 있어야 본문에 삽입할 수 있습니다.');
      }
    },
    [closeContextMenu, onInsertIntoManuscript, showShellToast],
  );

  const isEditing = creating !== null || renamingPath !== null;
  const {
    focusedPath,
    setFocusedPath,
    multiSelectedPaths,
    handleRowClick,
    handleTreeKeyDown,
  } = useTreeSelection({
    rows,
    isEditing,
    activateRow,
    toggleFolder,
    startRename,
    requestDelete,
  });

  const handleContextMenu = useCallback(
    (row: FlatTreeRow, event: MouseEvent) => {
      event.preventDefault();
      if (row.node.type === 'truncated') {
        return;
      }
      setFocusedPath(row.node.path);
      setContextMenu({ x: event.clientX, y: event.clientY, row });
    },
    [setFocusedPath],
  );

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const handle = () => closeContextMenu();
    window.addEventListener('click', handle);
    window.addEventListener('blur', handle);
    return () => {
      window.removeEventListener('click', handle);
      window.removeEventListener('blur', handle);
    };
  }, [closeContextMenu, contextMenu]);

  const {
    dropTargetPath,
    handleDragStart,
    handleDragOver,
    handleDrop,
    clearDropTarget,
  } = useTreeDragDrop({
    onManageEntry,
    showToast: showShellToast,
    expandDirectory,
  });

  return (
    <section className="computer-tree">
      <div className="rail-section-head">
        <span className="rail-section-label">
          {browseEnabled ? (
            // 경로가 곧 라벨이다 — 항상 한 줄 말줄임으로 정렬을 지키고,
            // 올리면(또는 포커스하면) 전체 경로 토글이 아래로 뜬다
            <span className="rail-browse-path" tabIndex={0}>
              <span className="rail-browse-path-short">
                {browsePath === '' ? '컴퓨터' : `컴퓨터 / ${browsePath}`}
              </span>
              <span className="rail-browse-path-full" role="tooltip">
                {browsePath === '' ? '컴퓨터' : `컴퓨터 / ${browsePath}`}
              </span>
            </span>
          ) : (
            '파일'
          )}
        </span>
        <span className="rail-section-actions">
          {browseEnabled ? (
            <button
              type="button"
              className="rail-icon-button"
              title="상위 폴더로"
              aria-label="상위 폴더로"
              disabled={browsePath === ''}
              onClick={() => onNavigateUp?.()}
            >
              ↑
            </button>
          ) : null}
          <button
            type="button"
            className="rail-icon-button"
            title="새 파일"
            aria-label="새 파일"
            onClick={() => startCreate(browseEnabled ? browsePath : '', 'file')}
          >
            +
          </button>
          <button
            type="button"
            className="rail-icon-button"
            title="새 폴더"
            aria-label="새 폴더"
            onClick={() =>
              startCreate(browseEnabled ? browsePath : '', 'folder')
            }
          >
            ⊞
          </button>
        </span>
      </div>
      {browseEnabled ? (
        <nav className="rail-browse-breadcrumbs" aria-label="현재 폴더 경로">
          {buildPathBreadcrumbs(browsePath).map((breadcrumb, index) => (
            <span key={breadcrumb.path || '(root)'}>
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              <button
                type="button"
                aria-label={`경로로 이동: ${breadcrumb.label}`}
                disabled={breadcrumb.path === browsePath}
                onClick={() => onNavigateInto?.(breadcrumb.path)}
              >
                {breadcrumb.label}
              </button>
            </span>
          ))}
        </nav>
      ) : null}
      {browseEnabled ? (
        <nav className="quick-access" aria-label="빠른 위치">
          <span className="quick-access-heading" aria-hidden="true">
            빠른 위치
          </span>
          {buildQuickAccessLinks(
            browseStartPath,
            browseShortcuts,
            favoriteDirectories,
          ).map((link) => (
            <button
              key={link.path || '(root)'}
              type="button"
              className={`quick-access-item${
                browsePath === link.path ? ' active' : ''
              }`}
              onClick={() => onNavigateInto?.(link.path)}
            >
              <span
                className={`quick-access-icon ${link.icon}`}
                aria-hidden="true"
              />
              {link.label}
            </button>
          ))}
        </nav>
      ) : null}
      {uiError ? (
        <div className="rail-alert" role="alert">
          {uiError}
        </div>
      ) : null}
      {shellToast ? (
        <div className="rail-toast" role="status">
          {shellToast}
        </div>
      ) : null}
      {confirmDeletePath ? (
        <div className="rail-toast" role="alertdialog">
          <div>{baseNameOf(confirmDeletePath)}을(를) 삭제할까요?</div>
          <div className="rail-toast-actions">
            <button type="button" onClick={() => void commitDelete()}>
              삭제
            </button>
            <button type="button" onClick={() => setConfirmDeletePath(null)}>
              취소
            </button>
          </div>
        </div>
      ) : null}
      {creating !== null &&
      creating.directory === (browseEnabled ? browsePath : '') ? (
        <TreeEditInput
          inputRef={editInputRef}
          value={createName}
          depth={0}
          placeholder={
            creating.kind === 'file' ? '새 파일 이름' : '새 폴더 이름'
          }
          onChange={setCreateName}
          onCommit={() => void commitCreate()}
          onCancel={cancelCreate}
        />
      ) : null}
      {browseEnabled ? (
        <div className="current-directory-heading" aria-hidden="true">
          현재 폴더
        </div>
      ) : null}
      {rows.length === 0 && creating === null && !browseEnabled ? (
        <p className="tree-empty">아직 파일이 없습니다</p>
      ) : (
        <div
          ref={treeScrollRef}
          className="tree"
          role="tree"
          aria-label={browseEnabled ? '현재 폴더 내용' : '파일 트리'}
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
          onScroll={handleTreeScroll}
        >
          <div style={{ height: visibleWindow.start * TREE_ROW_HEIGHT }} />
          {visibleWindow.rows.map((row) => (
            <div key={row.node.path}>
              {renamingPath === row.node.path ? (
                <TreeEditInput
                  inputRef={editInputRef}
                  value={renameValue}
                  depth={row.depth}
                  placeholder="새 이름"
                  onChange={setRenameValue}
                  onCommit={() => void commitRename()}
                  onCancel={cancelRename}
                />
              ) : (
                <TreeRow
                  row={row}
                  browseEnabled={browseEnabled}
                  onNavigateInto={onNavigateInto}
                  isActive={row.node.path === selectedPath}
                  isFocused={row.node.path === focusedPath}
                  isSelected={multiSelectedPaths.has(row.node.path)}
                  isDropTarget={row.node.path === dropTargetPath}
                  onClick={handleRowClick}
                  onContextMenu={handleContextMenu}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragLeave={clearDropTarget}
                  onDrop={handleDrop}
                />
              )}
              {creating !== null && creating.directory === row.node.path ? (
                <TreeEditInput
                  inputRef={editInputRef}
                  value={createName}
                  depth={row.depth + 1}
                  placeholder={
                    creating.kind === 'file' ? '새 파일 이름' : '새 폴더 이름'
                  }
                  onChange={setCreateName}
                  onCommit={() => void commitCreate()}
                  onCancel={cancelCreate}
                />
              ) : null}
            </div>
          ))}
          <div
            style={{
              height: (rows.length - visibleWindow.end) * TREE_ROW_HEIGHT,
            }}
          />
        </div>
      )}
      {contextMenu ? (
        <TreeContextMenu
          menu={contextMenu}
          onClose={closeContextMenu}
          onCreateFile={(directory) => startCreate(directory, 'file')}
          onCreateFolder={(directory) => startCreate(directory, 'folder')}
          onOpenFile={(path) => {
            closeContextMenu();
            void onSelect(path);
          }}
          onRename={startRename}
          onDelete={requestDelete}
          onInsertIntoManuscript={handleInsertIntoManuscript}
        />
      ) : null}
    </section>
  );
}

const TreeRow = memo(function TreeRow(props: {
  row: FlatTreeRow;
  browseEnabled: boolean;
  onNavigateInto?: ((path: string) => void) | undefined;
  isActive: boolean;
  isFocused: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  onClick: (row: FlatTreeRow, event: MouseEvent) => void;
  onContextMenu: (row: FlatTreeRow, event: MouseEvent) => void;
  onDragStart: (row: FlatTreeRow, event: DragEvent) => void;
  onDragOver: (row: FlatTreeRow, event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (row: FlatTreeRow, event: DragEvent) => void;
}) {
  const {
    row,
    browseEnabled,
    onNavigateInto,
    isActive,
    isFocused,
    isSelected,
    isDropTarget,
    onClick,
    onContextMenu,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
  } = props;
  const { node, depth, isExpanded } = row;
  const isFolder = node.type === 'directory';
  const isTruncated = node.type === 'truncated';
  const classes = [
    'tree-node',
    isFolder ? 'folder' : '',
    isTruncated ? 'truncated' : '',
    isActive ? 'active' : '',
    isSelected ? 'selected' : '',
    isFocused ? 'focused' : '',
    isDropTarget ? 'drop-active' : '',
    node.type === 'file' && isCanvasEligibleFileName(node.name)
      ? 'canvas-eligible'
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={isFolder ? isExpanded : undefined}
      aria-selected={isActive || isSelected}
      aria-disabled={isTruncated || undefined}
      className={classes}
      style={{ paddingLeft: 16 + depth * 18 }}
      draggable={!isTruncated}
      onClick={(event) => onClick(row, event)}
      onDoubleClick={
        browseEnabled && row.node.type === 'directory'
          ? () => onNavigateInto?.(row.node.path)
          : undefined
      }
      onContextMenu={(event) => onContextMenu(row, event)}
      onDragStart={isTruncated ? undefined : (event) => onDragStart(row, event)}
      onDragOver={isTruncated ? undefined : (event) => onDragOver(row, event)}
      onDragLeave={isTruncated ? undefined : onDragLeave}
      onDrop={isTruncated ? undefined : (event) => onDrop(row, event)}
    >
      {isFolder ? (
        <span className={`tree-disclosure${isExpanded ? ' expanded' : ''}`}>
          ▸
        </span>
      ) : (
        <span className="tree-disclosure" />
      )}
      <span
        className={`tree-icon ${
          isFolder ? 'folder' : isTruncated ? 'truncated' : 'file'
        }`}
        aria-hidden="true"
      />
      <span
        className="tree-node-label"
        title={isTruncated ? node.message : node.name}
      >
        {node.name}
      </span>
    </button>
  );
});

function TreeEditInput(props: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  depth: number;
  placeholder: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { inputRef, value, depth, placeholder, onChange, onCommit, onCancel } =
    props;
  return (
    <div className="tree-node" style={{ paddingLeft: 16 + depth * 18 }}>
      <span className="tree-disclosure" />
      <span className="tree-icon file" aria-hidden="true" />
      <input
        ref={inputRef}
        className="tree-entry-input"
        name="computer-tree-entry-name"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </div>
  );
}

function buildQuickAccessLinks(
  browseStartPath: string,
  browseShortcuts: Array<{ label: string; path: string }>,
  favoriteDirectories: ReadonlyArray<{ path: string }> = [],
): Array<{ label: string; path: string; icon: QuickAccessIconKind }> {
  const links: Array<{
    label: string;
    path: string;
    icon: QuickAccessIconKind;
  }> = [];
  const seenPaths = new Set<string>();
  const append = (link: {
    label: string;
    path: string;
    icon: QuickAccessIconKind;
  }) => {
    if (!seenPaths.has(link.path)) {
      seenPaths.add(link.path);
      links.push(link);
    }
  };
  if (browseStartPath) {
    append({ label: '홈', path: browseStartPath, icon: 'home' });
  }
  // 사용자가 직접 고정한 것이 자동 발견 경로보다 먼저 온다.
  for (const favorite of favoriteDirectories) {
    append({
      label: quickAccessLeafLabel(favorite.path),
      path: favorite.path,
      icon: 'folder',
    });
  }
  for (const shortcut of browseShortcuts) {
    append({
      label: shortcut.label,
      path: shortcut.path,
      icon:
        shortcut.path === ''
          ? 'computer'
          : /\([A-Z]:\)$/u.test(shortcut.label)
            ? 'drive'
            : 'folder',
    });
  }
  append({ label: '컴퓨터', path: '', icon: 'computer' });
  return links;
}

/** 빠른 위치 줄 이름 — 전체 경로는 길어서 마지막 조각을 쓴다. */
function quickAccessLeafLabel(path: string): string {
  const leaf = path
    .split('/')
    .filter((segment) => segment !== '')
    .at(-1);
  return leaf ?? path;
}
