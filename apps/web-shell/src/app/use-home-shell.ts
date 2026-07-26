import { useCallback, useEffect, useRef, useState } from 'react';

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
  // cwd는 파일 권한이나 탐색 위치가 아니라, 상대 경로와 명령의 명시적
  // 시작점이다. 사용자가 고르기 전에는 daemon의 Computer 홈 기본값을 쓴다.
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null);
  const workingDirectorySelectedRef = useRef(false);
  const navigateIntoBrowseDirectory = files.navigateInto;
  useEffect(() => {
    if (!workingDirectorySelectedRef.current && files.browseEnabled) {
      setWorkingDirectory(files.browseStartPath);
    }
  }, [files.browseEnabled, files.browseStartPath]);
  const [directoryPreferences, setDirectoryPreferences] =
    useState<DirectoryPreferencesResponse>({
      workingDirectory: null,
      favorites: [],
      recents: [],
    });
  // daemon이 기억한 작업 위치를 복원한다. 이게 없으면 daemon이 죽거나 브라우저를
  // 새로 열 때마다 홈으로 돌아간다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const preferences = await fetchDirectoryPreferences();
        if (cancelled) {
          return;
        }
        setDirectoryPreferences(preferences);
        if (preferences.workingDirectory !== null) {
          workingDirectorySelectedRef.current = true;
          setWorkingDirectory(preferences.workingDirectory);
          navigateIntoBrowseDirectory(preferences.workingDirectory);
        }
      } catch (error: unknown) {
        // 못 읽으면 daemon 홈에서 시작한다. 조용히 덮지 않고 남긴다.
        logger.warn('directory preferences could not be read:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigateIntoBrowseDirectory]);
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
    (path: string) => {
      workingDirectorySelectedRef.current = true;
      setWorkingDirectory(path);
      navigateIntoBrowseDirectory(path);
      // daemon이 cwd를 기억하고 최근 목록도 갱신한다. 자동 발견 경로 제외 판단도
      // daemon 몫이다 — 셸이 그 목록을 복제하지 않는다.
      void applyDirectoryPreference('select', path)
        .then(setDirectoryPreferences)
        .catch((error: unknown) => {
          logger.warn('working directory could not be persisted:', error);
        });
    },
    [navigateIntoBrowseDirectory],
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
  const runSession = useRunSession({
    ...(workingDirectory === null ? {} : { workingDirectory }),
    selectedFile: files.selectedFile,
    selectedThreadId: threads.selectedThreadId,
    loadThreads: threads.loadThreads,
    loadTree: files.loadTree,
    openFile: files.openFile,
    appendOptimisticUserMessage: threads.appendOptimisticUserMessage,
    trimMessagesForRegenerate: threads.trimMessagesForRegenerate,
    setSelectedThreadId: threads.setSelectedThreadId,
    openThreadForRunSettle: threads.openThreadForRunSettle,
    applyThreadSnapshotForRunSettle: threads.applyThreadSnapshotForRunSettle,
  });
  const { setModelId: setRunModelId } = runSession;
  useEffect(() => {
    if (threads.activeModelId !== null) {
      setRunModelId(threads.activeModelId);
    }
  }, [setRunModelId, threads.activeModelId]);

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
    // draft → 버전 커밋 결과를 로컬 아티팩트 상태에 즉시 반영하는 핸들
    upsertThreadArtifactVersion: threads.upsertThreadArtifactVersion,
  };
}
