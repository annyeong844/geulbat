import { useCallback, useState } from 'react';

import type {
  ComputerFileBrowseShortcut,
  DirectoryPreferenceEntry,
} from '@geulbat/protocol/files';

import { getErrorMessage } from '../../lib/error-message.js';

export interface AssistantWorkspace {
  workingDirectory: string | null;
  browseEnabled: boolean;
  browsePath: string;
  browseStartPath: string;
  browseShortcuts: readonly ComputerFileBrowseShortcut[];
  /** 사용자가 실제로 고른 폴더. 자동 발견 경로 제외는 daemon이 판단해서 보낸다. */
  recentDirectories?: readonly DirectoryPreferenceEntry[];
  /** 사용자가 직접 고정한 폴더. */
  favoriteDirectories?: readonly DirectoryPreferenceEntry[];
  onToggleFavoriteDirectory?: (path: string, pinned: boolean) => void;
  onSelectWorkingDirectory: ((path: string) => void) | undefined;
  onChooseWorkingDirectory: (() => Promise<void>) | undefined;
}

// 시작 위치 선택 오버레이 — 브라우즈 다이얼로그(열림) 또는 실패 알림줄. 둘 다
// 아니면 null. WorkingDirectoryPickerDialog가 이 값 하나로 렌더를 결정한다.
export type WorkingDirectoryOverlay =
  | {
      kind: 'picker';
      initialPath: string;
      browsePath: string;
      browseStartPath: string;
      browseShortcuts: readonly ComputerFileBrowseShortcut[];
      recentDirectories: readonly DirectoryPreferenceEntry[];
      favoriteDirectories: readonly DirectoryPreferenceEntry[];
      onToggleFavorite: ((path: string, pinned: boolean) => void) | undefined;
      onSelect: (path: string) => void;
      onClose: () => void;
    }
  | { kind: 'error'; message: string }
  | null;

interface WorkingDirectoryPicker {
  // 컴포저 위 컨텍스트 줄 라벨 — 어시스턴트가 보고 있는 시작 위치
  contextLabel: string;
  // 위치를 바꿀 수단이 하나라도 있는가 (네이티브 선택 또는 브라우즈)
  canChange: boolean;
  // 네이티브 선택 창이 뜬 뒤 아직 안 닫힌 단일 비행 상태
  selectionPending: boolean;
  openPicker: () => void;
  overlay: WorkingDirectoryOverlay;
}

// Assistant 본문에서 시작 위치 선택 상태(피커 열림/진행/실패)와 로직을 걷어내
// 한곳에 모은다. 컨텍스트 줄 버튼과 컴포저가 openPicker/contextLabel/
// selectionPending을 공유하므로, 자체 렌더를 갖는 컴포넌트가 아니라 훅으로
// 소유한다. 렌더가 필요한 오버레이만 값으로 내보낸다.
export function useWorkingDirectoryPicker({
  workingDirectory,
  browseEnabled,
  browsePath,
  browseStartPath,
  browseShortcuts,
  recentDirectories = [],
  favoriteDirectories = [],
  onToggleFavoriteDirectory,
  onSelectWorkingDirectory,
  onChooseWorkingDirectory,
}: AssistantWorkspace): WorkingDirectoryPicker {
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectionPending, setSelectionPending] = useState(false);

  const chooseWorkingDirectory = useCallback(async () => {
    if (onChooseWorkingDirectory === undefined || selectionPending) {
      return;
    }
    setSelectionPending(true);
    setSelectionError(null);
    try {
      await onChooseWorkingDirectory();
    } catch (error: unknown) {
      setSelectionError(
        `시작 위치 창을 열지 못했습니다. ${getErrorMessage(error)}`,
      );
    } finally {
      setSelectionPending(false);
    }
  }, [onChooseWorkingDirectory, selectionPending]);

  const openPicker = useCallback(() => {
    setSelectionError(null);
    if (browseEnabled && onSelectWorkingDirectory !== undefined) {
      setPickerOpen(true);
      return;
    }
    void chooseWorkingDirectory();
  }, [browseEnabled, chooseWorkingDirectory, onSelectWorkingDirectory]);

  const contextPath = workingDirectory ?? browseStartPath;
  const contextLabel = contextPath === '' ? '컴퓨터 루트' : contextPath;
  const canChange =
    onSelectWorkingDirectory !== undefined ||
    onChooseWorkingDirectory !== undefined;

  let overlay: WorkingDirectoryOverlay = null;
  if (pickerOpen && onSelectWorkingDirectory !== undefined) {
    overlay = {
      kind: 'picker',
      initialPath: workingDirectory ?? browseStartPath,
      browsePath,
      browseStartPath,
      browseShortcuts,
      recentDirectories,
      favoriteDirectories,
      onToggleFavorite: onToggleFavoriteDirectory,
      onSelect: (path: string) => {
        onSelectWorkingDirectory(path);
        setSelectionError(null);
        setPickerOpen(false);
      },
      onClose: () => setPickerOpen(false),
    };
  } else if (selectionError !== null && !pickerOpen) {
    overlay = { kind: 'error', message: selectionError };
  }

  return { contextLabel, canChange, selectionPending, openPicker, overlay };
}
