import {
  createProjectWorkspaceShellView,
  type ProjectWorkspaceProps,
} from './project-workspace-shell.js';
import { createProjectWorkspaceFilesInput } from './project-workspace-files-input.js';
import { createProjectWorkspaceRunSessionInput } from './project-workspace-run-session-input.js';
import { createProjectWorkspaceThreadsInput } from './project-workspace-threads-input.js';
import { useRunSession } from './use-run-session.js';
import { useThreadSessions } from './use-thread-sessions.js';
import { useWorkspaceFiles } from './use-workspace-files.js';

export function useProjectWorkspaceShell({
  providerAuthStatuses,
  providerAuthBusyProviderId,
  providerAuthErrors,
  onConnectProvider,
  onDisconnectProvider,
}: ProjectWorkspaceProps) {
  const files = useWorkspaceFiles();
  const threads = useThreadSessions();
  const runSession = useRunSession({
    workingDirectory: files.browsePath,
    selectedFile: files.selectedFile,
    selectedThreadId: threads.selectedThreadId,
    loadThreads: threads.loadThreads,
    loadTree: files.loadTree,
    openFile: files.openProjectFile,
    appendOptimisticUserMessage: threads.appendOptimisticUserMessage,
    trimMessagesForRegenerate: threads.trimMessagesForRegenerate,
    setSelectedThreadId: threads.setSelectedThreadId,
    openThreadForRunSettle: threads.openThreadForRunSettle,
    applyThreadSnapshotForRunSettle: threads.applyThreadSnapshotForRunSettle,
  });

  const shellView = createProjectWorkspaceShellView({
    providerAuthStatuses,
    providerAuthBusyProviderId,
    providerAuthErrors,
    onConnectProvider,
    onDisconnectProvider,
    files: createProjectWorkspaceFilesInput(files),
    threads: createProjectWorkspaceThreadsInput(threads),
    runSession: createProjectWorkspaceRunSessionInput(runSession),
  });

  return {
    ...shellView,
    // draft → 버전 커밋 결과를 로컬 아티팩트 상태에 즉시 반영하는 핸들
    upsertThreadArtifactVersion: threads.upsertThreadArtifactVersion,
  };
}
