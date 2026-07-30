import { useCallback, useEffect, useState } from 'react';

import { createHomeShellView, type HomeShellProps } from './home-shell.js';
import { createHomeFilesInput } from './home-files-input.js';
import { createHomeRunSessionInput } from './home-run-session-input.js';
import { createHomeThreadsInput } from './home-threads-input.js';
import { useRunSession } from './use-run-session.js';
import { useThreadSessions } from './use-thread-sessions.js';
import { useComputerFiles } from './use-computer-files.js';
import {
  applyDirectoryPreference,
  fetchDirectoryPreferences,
  selectComputerDirectory,
} from '../lib/api/files.js';
import type { DirectoryPreferencesResponse } from '@geulbat/protocol/files';
import { createLogger } from '@geulbat/structured-logger/logger';

const logger = createLogger('home-shell');

export function useHomeShell({
  providerAuthStatuses,
  providerAuthBusyProviderId,
  providerAuthErrors,
  onConnectProvider,
  onDisconnectProvider,
}: HomeShellProps) {
  const files = useComputerFiles();
  const threads = useThreadSessions();
  const navigateIntoBrowseDirectory = files.navigateInto;
  const runSession = useRunSession({
    selectedFile: files.selectedFile,
    selectedThreadId: threads.selectedThreadId,
    newSessionGeneration: threads.newSessionGeneration,
    activeModelId: threads.activeModelId,
    runPreferences: threads.runPreferences,
    loadThreads: threads.loadThreads,
    loadTree: files.loadTree,
    openFile: files.openFile,
    appendOptimisticUserMessage: threads.appendOptimisticUserMessage,
    trimMessagesForRegenerate: threads.trimMessagesForRegenerate,
    setSelectedThreadId: threads.setSelectedThreadId,
    openThreadForRunSettle: threads.openThreadForRunSettle,
    applyThreadSnapshotForRunSettle: threads.applyThreadSnapshotForRunSettle,
  });
  const { workingDirectory, setWorkingDirectory } = runSession;
  const [directoryPreferences, setDirectoryPreferences] =
    useState<DirectoryPreferencesResponse>({
      workingDirectory: null,
      favorites: [],
      recents: [],
    });
  // daemon은 탐색 편의를 위한 최근/즐겨찾기만 복원한다. 실행 cwd는 채팅 세션
  // 설정이라 전역 directory preference에서 복원하지 않는다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const preferences = await fetchDirectoryPreferences();
        if (cancelled) {
          return;
        }
        setDirectoryPreferences(preferences);
      } catch (error: unknown) {
        // 못 읽어도 현재 세션 cwd는 안전한 기본값을 유지한다.
        logger.warn('directory preferences could not be read:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleFavoriteDirectory = useCallback(
    (path: string, pinned: boolean) => {
      void applyDirectoryPreference(pinned ? 'pin' : 'unpin', path)
        .then(setDirectoryPreferences)
        .catch((error: unknown) => {
          logger.warn('favorite directory could not be updated:', error);
        });
    },
    [],
  );
  const selectWorkingDirectory = useCallback(
    (path: string | null) => {
      setWorkingDirectory(path);
      if (path === null) {
        return;
      }
      navigateIntoBrowseDirectory(path);
      if (path === '') {
        // 빈 portable coordinate는 컴퓨터 루트다. 세션 CWD로는 유효하지만
        // 최근 폴더에 저장할 실제 하위 경로는 아니다.
        return;
      }
      // daemon preference의 select verb는 최근 경로 목록도 함께 갱신한다.
      // 다음 새 세션의 cwd는 이 전역 편의값을 상속하지 않는다.
      void applyDirectoryPreference('select', path)
        .then(setDirectoryPreferences)
        .catch((error: unknown) => {
          logger.warn('working directory could not be persisted:', error);
        });
    },
    [navigateIntoBrowseDirectory, setWorkingDirectory],
  );
  const chooseWorkingDirectory = useCallback(async () => {
    const selection = await selectComputerDirectory(
      workingDirectory ?? files.browseStartPath,
    );
    if (selection.status === 'selected') {
      selectWorkingDirectory(selection.path);
    }
  }, [files.browseStartPath, selectWorkingDirectory, workingDirectory]);
  const browseDirectoryPath = files.browsePath || files.browseStartPath;
  const chooseBrowseDirectory = useCallback(async () => {
    const selection = await selectComputerDirectory(browseDirectoryPath);
    if (selection.status === 'selected') {
      navigateIntoBrowseDirectory(selection.path);
    }
  }, [browseDirectoryPath, navigateIntoBrowseDirectory]);
  const shellView = createHomeShellView({
    providerAuthStatuses,
    providerAuthBusyProviderId,
    providerAuthErrors,
    onConnectProvider,
    onDisconnectProvider,
    files: createHomeFilesInput(files),
    threads: createHomeThreadsInput(threads),
    runSession: createHomeRunSessionInput(runSession),
  });

  return {
    ...shellView,
    workingDirectory,
    selectWorkingDirectory,
    chooseWorkingDirectory,
    directoryPreferences,
    toggleFavoriteDirectory,
    chooseBrowseDirectory,
    refreshComputerFileScope: files.refreshComputerFileScope,
    recentFiles: files.recentFiles,
    openFile: files.openFile,
    removeRecentFile: files.removeRecentFile,
    fileMutationGeneration: files.mutationGeneration,
    // draft → 버전 커밋 결과를 로컬 아티팩트 상태에 즉시 반영하는 핸들
    upsertThreadArtifactVersion: threads.upsertThreadArtifactVersion,
  };
}
