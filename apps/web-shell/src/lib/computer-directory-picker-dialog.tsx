import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ComputerFileBrowseShortcut,
  DirectoryPreferenceEntry,
  FileTreeNode,
} from '@geulbat/protocol/files';

import { COMPUTER_FILE_API_SCOPE, getFileTree } from './api/files.js';
import { buildPathBreadcrumbs, parentDirOf } from './path-name.js';

type DirectoryEntry = Extract<FileTreeNode, { type: 'directory' }>;

interface Props {
  title: string;
  confirmLabel: string;
  clearLabel?: string;
  initialPath: string;
  browsePath: string;
  browseStartPath: string;
  browseShortcuts: readonly ComputerFileBrowseShortcut[];
  /** 사용자가 실제로 고른 폴더. 자동 발견 경로는 daemon이 이미 걸러서 보낸다. */
  recentDirectories?: readonly DirectoryPreferenceEntry[];
  /** 사용자가 직접 고정한 폴더. */
  favoriteDirectories?: readonly DirectoryPreferenceEntry[];
  onToggleFavorite?: ((path: string, pinned: boolean) => void) | undefined;
  onSelect: (path: string) => void;
  onClear?: () => void;
  onClose: () => void;
}

export function ComputerDirectoryPickerDialog({
  title,
  confirmLabel,
  clearLabel,
  initialPath,
  browsePath,
  browseStartPath,
  browseShortcuts,
  recentDirectories = [],
  favoriteDirectories = [],
  onToggleFavorite,
  onSelect,
  onClear,
  onClose,
}: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestEpochRef = useRef(0);

  const loadDirectory = useCallback(async (path: string) => {
    const requestEpoch = (requestEpochRef.current += 1);
    setCurrentPath(path);
    setLoading(true);
    setLoadError(null);
    try {
      const response = await getFileTree(COMPUTER_FILE_API_SCOPE, {
        ...(path === '' ? {} : { path }),
        depth: 1,
      });
      if (requestEpoch !== requestEpochRef.current) {
        return;
      }
      setDirectories(
        response.tree.filter(
          (entry): entry is DirectoryEntry => entry.type === 'directory',
        ),
      );
    } catch (error: unknown) {
      if (requestEpoch !== requestEpochRef.current) {
        return;
      }
      setDirectories([]);
      setLoadError(
        error instanceof TypeError
          ? '데몬 연결이 잠시 끊겼습니다. 다시 시도해 주세요.'
          : error instanceof Error && error.message.trim() !== ''
            ? error.message
            : '폴더 목록을 불러오지 못했습니다.',
      );
    } finally {
      if (requestEpoch === requestEpochRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadDirectory(initialPath);
    return () => {
      requestEpochRef.current += 1;
    };
  }, [initialPath, loadDirectory]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  // 즐겨찾기·기본 경로·최근 폴더는 각각 다른 것이다 — 한 줄 목록에 섞지 않고
  // 이름 붙은 묶음으로 나눈다.
  const locationGroups = useMemo(() => {
    const seenPaths = new Set<string>();
    const groupOf = (
      heading: string,
      entries: ReadonlyArray<{ label: string; path: string }>,
    ) => {
      const items: Array<{ label: string; path: string }> = [];
      for (const entry of entries) {
        if (seenPaths.has(entry.path)) {
          continue;
        }
        seenPaths.add(entry.path);
        items.push(entry);
      }
      return { heading, items };
    };

    const groups = [
      groupOf('지금 위치', [{ label: '현재 탐색 위치', path: browsePath }]),
      groupOf(
        '즐겨찾기',
        favoriteDirectories.map((favorite) => ({
          label: directoryLeafLabel(favorite.path),
          path: favorite.path,
        })),
      ),
      groupOf('기본 경로', [
        ...(browseStartPath !== ''
          ? [{ label: '홈', path: browseStartPath }]
          : []),
        ...browseShortcuts.map((shortcut) => ({
          label: shortcut.label,
          path: shortcut.path,
        })),
        { label: '컴퓨터', path: '' },
      ]),
      groupOf(
        '최근 폴더',
        recentDirectories.map((recent) => ({
          label: directoryLeafLabel(recent.path),
          path: recent.path,
        })),
      ),
    ];
    return groups.filter((group) => group.items.length > 0);
  }, [
    browsePath,
    browseShortcuts,
    browseStartPath,
    favoriteDirectories,
    recentDirectories,
  ]);
  const favoritePaths = useMemo(
    () => new Set(favoriteDirectories.map((entry) => entry.path)),
    [favoriteDirectories],
  );

  return (
    <>
      <button
        type="button"
        aria-label={`${title} 취소`}
        className="video-settings-backdrop"
        onClick={onClose}
      />
      <section
        className="video-settings-card computer-directory-picker-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="computer-directory-picker-title"
      >
        <div className="video-settings-header">
          <h2
            id="computer-directory-picker-title"
            className="video-settings-title"
          >
            {title}
          </h2>
          <button
            type="button"
            className="video-settings-close"
            aria-label={`${title} 닫기`}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* 위치 목록은 왼쪽 세로 칸이다. 위쪽 가로 줄이면 항목이 늘어날 때마다
            옆으로 밀려서 가로 스크롤을 해야 한다 — 세로로 쌓으면 그냥 내려가면 된다. */}
        <div className="computer-directory-picker-body">
          <nav
            className="computer-directory-picker-locations"
            aria-label="컴퓨터 위치"
          >
            {locationGroups.map((group) => (
              <section key={group.heading}>
                <h3 className="computer-directory-picker-locations-heading">
                  {group.heading}
                </h3>
                {group.items.map((item) => (
                  <button
                    key={`${group.heading}:${item.path}`}
                    type="button"
                    className={currentPath === item.path ? 'active' : ''}
                    title={item.path === '' ? '컴퓨터' : item.path}
                    onClick={() => void loadDirectory(item.path)}
                  >
                    {item.label}
                  </button>
                ))}
              </section>
            ))}
          </nav>

          <div className="computer-directory-picker-main">
            {/* 지금 보고 있는 폴더를 즐겨찾기에 넣거나 뺀다 — 자동 발견 경로만으로는
            자기 작업 폴더가 목록에 영원히 안 들어온다. */}
            {onToggleFavorite !== undefined && currentPath !== '' ? (
              <button
                type="button"
                className="computer-directory-picker-pin"
                onClick={() =>
                  onToggleFavorite(currentPath, !favoritePaths.has(currentPath))
                }
                aria-pressed={favoritePaths.has(currentPath)}
                title={
                  favoritePaths.has(currentPath)
                    ? `즐겨찾기에서 제거: ${currentPath}`
                    : `즐겨찾기에 추가: ${currentPath}`
                }
              >
                {favoritePaths.has(currentPath)
                  ? '★ 즐겨찾기'
                  : '☆ 즐겨찾기에 추가'}
              </button>
            ) : null}

            <div className="computer-directory-picker-path">
              <button
                type="button"
                aria-label="상위 폴더로"
                disabled={currentPath === '' || loading}
                onClick={() => void loadDirectory(parentDirOf(currentPath))}
              >
                ↑
              </button>
              <nav aria-label="선택 폴더 경로">
                {buildPathBreadcrumbs(currentPath).map((breadcrumb, index) => (
                  <span key={breadcrumb.path || '(root)'}>
                    {index > 0 ? <span aria-hidden="true">/</span> : null}
                    <button
                      type="button"
                      aria-label={`경로로 이동: ${breadcrumb.label}`}
                      disabled={loading || breadcrumb.path === currentPath}
                      onClick={() => void loadDirectory(breadcrumb.path)}
                    >
                      {breadcrumb.label}
                    </button>
                  </span>
                ))}
              </nav>
            </div>

            <div
              className="computer-directory-picker-list"
              aria-label="하위 폴더"
            >
              {loading ? (
                <p>폴더를 불러오는 중…</p>
              ) : loadError !== null ? (
                <p role="alert">{loadError}</p>
              ) : directories.length === 0 ? (
                <p>하위 폴더가 없습니다.</p>
              ) : (
                directories.map((directory) => (
                  <button
                    key={directory.path}
                    type="button"
                    aria-label={`폴더 열기: ${directory.name}`}
                    onClick={() => void loadDirectory(directory.path)}
                  >
                    <span aria-hidden="true">📁</span>
                    <span>{directory.name}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))
              )}
            </div>

            <div className="computer-directory-picker-actions">
              {clearLabel !== undefined && onClear !== undefined ? (
                <button
                  type="button"
                  className="video-settings-cancel"
                  onClick={onClear}
                >
                  {clearLabel}
                </button>
              ) : null}
              <button
                type="button"
                className="video-settings-save"
                disabled={loading}
                onClick={() => {
                  if (loadError !== null) {
                    void loadDirectory(currentPath);
                    return;
                  }
                  onSelect(currentPath);
                }}
              >
                {loadError === null ? confirmLabel : '다시 시도'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** 목록 줄 이름 — 전체 경로는 길어서 마지막 조각을 쓴다. */
function directoryLeafLabel(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const leaf = segments.at(-1);
  return leaf ?? path;
}
