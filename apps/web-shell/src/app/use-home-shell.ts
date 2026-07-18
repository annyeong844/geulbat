import { useCallback, useEffect, useRef, useState } from 'react';

import { createHomeShellView, type HomeShellProps } from './home-shell.js';
import { createHomeFilesInput } from './home-files-input.js';
import { createHomeRunSessionInput } from './home-run-session-input.js';
import { createHomeThreadsInput } from './home-threads-input.js';
import { useRunSession } from './use-run-session.js';
import { useThreadSessions } from './use-thread-sessions.js';
import { useComputerFiles } from './use-computer-files.js';
import { selectComputerDirectory } from '../lib/api/files.js';

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
  useEffect(() => {
    if (!workingDirectorySelectedRef.current && files.browseEnabled) {
      setWorkingDirectory(files.browseStartPath);
    }
  }, [files.browseEnabled, files.browseStartPath]);
  const selectWorkingDirectory = useCallback((path: string) => {
    workingDirectorySelectedRef.current = true;
    setWorkingDirectory(path);
  }, []);
  const chooseWorkingDirectory = useCallback(async () => {
    const selection = await selectComputerDirectory(
      workingDirectory ?? files.browseStartPath,
    );
    if (selection.status === 'selected') {
      selectWorkingDirectory(selection.path);
    }
  }, [files.browseStartPath, selectWorkingDirectory, workingDirectory]);
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
    chooseWorkingDirectory,
    // draft → 버전 커밋 결과를 로컬 아티팩트 상태에 즉시 반영하는 핸들
    upsertThreadArtifactVersion: threads.upsertThreadArtifactVersion,
  };
}
