import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import type { FileTreeNode } from '@geulbat/protocol/files';

import type { ManageFileOperation } from '../../lib/api/files.js';
import { baseNameOf, parentDirOf } from '../../lib/path-name.js';
import {
  flattenVisibleTree,
  isCanvasEligibleFileName,
  type FlatTreeRow,
} from './tree-flatten.js';
import {
  TreeContextMenu,
  type TreeContextMenuState,
} from './TreeContextMenu.js';

interface Props {
  tree: FileTreeNode[];
  uiError?: string | null;
  selectedPath?: string | null;
  browseEnabled?: boolean;
  browsePath?: string;
  browseStartPath?: string;
  browseShortcuts?: Array<{ label: string; path: string }>;
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

type CreateKind = 'file' | 'folder';

const TREE_ROW_HEIGHT = 26;
const TREE_DRAG_MIME = 'application/x-geulbat-tree-path';

/**
 * 좌측 탐색기 — VSCode/윈도우 탐색기 패턴의 user file ops shell input path
 * (§3.1). mutation semantics는 daemon owner이며, 모든 ops는 agent tool과
 * 같은 daemon mutation chain을 거친다 (§3.1.5).
 */
export function ProjectTree({
  tree,
  uiError,
  selectedPath = null,
  browseEnabled = false,
  browsePath = '',
  browseStartPath = '',
  browseShortcuts = [],
  onNavigateUp,
  onNavigateInto,
  onLoad,
  onLoadSubtree,
  onSelect,
  onCreateFile,
  onManageEntry,
  onInsertIntoManuscript,
}: Props) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [multiSelectedPaths, setMultiSelectedPaths] = useState<Set<string>>(
    new Set(),
  );
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(
    null,
  );
  const [shellToast, setShellToast] = useState<string | null>(null);
  const [creating, setCreating] = useState<{
    directory: string;
    kind: CreateKind;
  } | null>(null);
  const [createName, setCreateName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(
    null,
  );
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void onLoad();
  }, [onLoad]);

  useEffect(() => {
    if (creating !== null || renamingPath !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [creating, renamingPath]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // 가상 스크롤 — 보이는 행만 DOM에 그린다 (대형 폴더 네이티브급)
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollFrameRef = useRef<number | null>(null);
  const handleTreeScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(treeScrollRef.current?.scrollTop ?? 0);
    });
  }, []);
  useEffect(() => {
    const el = treeScrollRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const rows = useMemo(
    () => flattenVisibleTree(tree, expandedPaths),
    [tree, expandedPaths],
  );

  const visibleWindow = useMemo(() => {
    const overscan = 12;
    const start = Math.max(
      0,
      Math.floor(scrollTop / TREE_ROW_HEIGHT) - overscan,
    );
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + overscan,
    );
    return { start, end, rows: rows.slice(start, end) };
  }, [rows, scrollTop, viewportHeight]);

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

  const startCreate = useCallback((directory: string, kind: CreateKind) => {
    setCreating({ directory, kind });
    setCreateName('');
    setContextMenu(null);
    if (directory !== '') {
      setExpandedPaths((prev) => new Set(prev).add(directory));
    }
  }, []);

  const commitCreate = useCallback(async () => {
    const pending = creating;
    const name = createName.trim();
    setCreating(null);
    if (!pending || !name) {
      return;
    }
    const path =
      pending.directory === '' ? name : `${pending.directory}/${name}`;
    const created =
      pending.kind === 'file'
        ? await onCreateFile(path)
        : await onManageEntry('mkdir', path);
    if (created) {
      showShellToast(
        pending.kind === 'file'
          ? `${name} 파일을 만들었습니다.`
          : `${name} 폴더를 만들었습니다.`,
      );
    }
  }, [createName, creating, onCreateFile, onManageEntry, showShellToast]);

  const startRename = useCallback((path: string) => {
    setRenamingPath(path);
    setRenameValue(baseNameOf(path));
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(async () => {
    const path = renamingPath;
    const nextName = renameValue.trim();
    setRenamingPath(null);
    if (!path || !nextName || nextName === baseNameOf(path)) {
      return;
    }
    const parent = parentDirOf(path);
    const destination = parent === '' ? nextName : `${parent}/${nextName}`;
    const renamed = await onManageEntry('rename', path, destination);
    if (renamed) {
      showShellToast(`${nextName}(으)로 이름을 바꿨습니다.`);
    }
  }, [onManageEntry, renameValue, renamingPath, showShellToast]);

  const requestDelete = useCallback((path: string) => {
    setConfirmDeletePath(path);
    setContextMenu(null);
  }, []);

  const commitDelete = useCallback(async () => {
    const path = confirmDeletePath;
    setConfirmDeletePath(null);
    if (!path) {
      return;
    }
    const deleted = await onManageEntry('delete', path);
    if (deleted) {
      showShellToast(`${baseNameOf(path)}을(를) 삭제했습니다.`);
    }
  }, [confirmDeletePath, onManageEntry, showShellToast]);

  const handleInsertIntoManuscript = useCallback(
    (path: string) => {
      setContextMenu(null);
      if (onInsertIntoManuscript) {
        void onInsertIntoManuscript(path);
      } else {
        showShellToast('열린 문서가 있어야 본문에 삽입할 수 있습니다.');
      }
    },
    [onInsertIntoManuscript, showShellToast],
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
      if (creating !== null || renamingPath !== null) {
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
      creating,
      focusedPath,
      renamingPath,
      requestDelete,
      rows,
      startRename,
      toggleFolder,
    ],
  );

  const handleContextMenu = useCallback(
    (row: FlatTreeRow, event: MouseEvent) => {
      event.preventDefault();
      if (row.node.type === 'truncated') {
        return;
      }
      setFocusedPath(row.node.path);
      setContextMenu({ x: event.clientX, y: event.clientY, row });
    },
    [],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

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

  // 트리 안 drag-and-drop 이동 (§3.1.2)
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
          setExpandedPaths((prev) => new Set(prev).add(destinationDir));
          showShellToast(`${baseNameOf(source)}을(를) 옮겼습니다.`);
        }
      });
    },
    [onManageEntry, showShellToast],
  );

  return (
    <section className="project-tree">
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
        <nav className="quick-access" aria-label="바로가기">
          {buildQuickAccessLinks(browseStartPath, browseShortcuts).map(
            (link) => (
              <button
                key={link.path || '(root)'}
                type="button"
                className={`quick-access-item${
                  browsePath === link.path ? ' active' : ''
                }`}
                onClick={() => onNavigateInto?.(link.path)}
              >
                <span className="quick-access-icon">{link.icon}</span>
                {link.label}
              </button>
            ),
          )}
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
          onCancel={() => setCreating(null)}
        />
      ) : null}
      {rows.length === 0 && creating === null && !browseEnabled ? (
        <p className="tree-empty">아직 파일이 없습니다</p>
      ) : (
        <div
          ref={treeScrollRef}
          className="tree"
          role="tree"
          aria-label="파일 트리"
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
                  onCancel={() => setRenamingPath(null)}
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
                  onDragLeave={() => setDropTargetPath(null)}
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
                  onCancel={() => setCreating(null)}
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
      <span className="tree-icon">
        {isFolder ? '▣' : isTruncated ? '…' : '≡'}
      </span>
      <span
        className="tree-node-label"
        title={isTruncated ? node.message : undefined}
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
      <span className="tree-icon">≡</span>
      <input
        ref={inputRef}
        className="project-registry-input"
        name="project-tree-entry-name"
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

// 탐색기 사이드바 바로가기 — daemon이 실제 디스크에서 존재를 확인해
// 내려준 목록(browseShortcuts)만 표시한다. 홈과 루트는 셸이 앞뒤로 더한다.
const SHORTCUT_ICONS: Record<string, string> = {
  홈: '🏠',
  '바탕 화면': '🖥',
  다운로드: '⬇',
  문서: '📄',
  사진: '🖼',
  음악: '♪',
  동영상: '🎬',
  컴퓨터: '💻',
};

function buildQuickAccessLinks(
  browseStartPath: string,
  browseShortcuts: Array<{ label: string; path: string }>,
): Array<{ label: string; path: string; icon: string }> {
  const links: Array<{ label: string; path: string; icon: string }> = [];
  if (browseStartPath) {
    links.push({ label: '홈', path: browseStartPath, icon: '🏠' });
  }
  for (const shortcut of browseShortcuts) {
    links.push({
      label: shortcut.label,
      path: shortcut.path,
      icon: SHORTCUT_ICONS[shortcut.label] ?? '📁',
    });
  }
  links.push({ label: '컴퓨터', path: '', icon: '💻' });
  return links;
}
