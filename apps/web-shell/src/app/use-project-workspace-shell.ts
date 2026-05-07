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
  projectId,
  defaultProjectId,
  projects,
  projectRegistryError,
  projectRegistryBusy,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  providerAuthStatus,
  providerAuthBusy,
  providerAuthError,
  onConnectProvider,
  onDisconnectProvider,
}: ProjectWorkspaceProps) {
  const files = useWorkspaceFiles(projectId);
  const threads = useThreadSessions(projectId);
  const runSession = useRunSession({
    projectId,
    selectedFile: files.selectedFile,
    selectedThreadId: threads.selectedThreadId,
    loadThreads: threads.loadThreads,
    loadTree: files.loadTree,
    openFile: files.openFile,
    appendOptimisticUserMessage: threads.appendOptimisticUserMessage,
    setSelectedThreadId: threads.setSelectedThreadId,
    openThreadForRunSettle: threads.openThreadForRunSettle,
    applyThreadSnapshotForRunSettle: threads.applyThreadSnapshotForRunSettle,
  });

  return createProjectWorkspaceShellView({
    projectId,
    defaultProjectId,
    projects,
    projectRegistryError,
    projectRegistryBusy,
    onSelectProject,
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    providerAuthStatus,
    providerAuthBusy,
    providerAuthError,
    onConnectProvider,
    onDisconnectProvider,
    files: createProjectWorkspaceFilesInput(files),
    threads: createProjectWorkspaceThreadsInput(threads),
    runSession: createProjectWorkspaceRunSessionInput(runSession),
  });
}
