import type { ProjectListItem } from '@geulbat/protocol/projects';
import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';

import {
  createProjectWorkspaceCenterPanelView,
  createProjectWorkspaceLeftPanelView,
  createProjectWorkspaceRightPanelView,
} from './project-workspace-panel-views.js';
import type { createProjectWorkspaceFilesInput } from './project-workspace-files-input.js';
import { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';
import type { createProjectWorkspaceThreadsInput } from './project-workspace-threads-input.js';

export interface ProjectWorkspaceProps {
  projectId: string;
  defaultProjectId: string;
  projects: ProjectListItem[];
  projectRegistryError: string | null;
  projectRegistryBusy: boolean;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (label: string) => Promise<boolean>;
  onRenameProject: (projectId: string, label: string) => Promise<boolean>;
  onDeleteProject: (projectId: string) => Promise<boolean>;
  providerAuthStatus: ProviderAuthStatusResponse | null;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  onConnectProvider: () => Promise<void> | void;
  onDisconnectProvider: () => Promise<void> | void;
}

interface CreateProjectWorkspaceShellViewArgs extends ProjectWorkspaceProps {
  files: ReturnType<typeof createProjectWorkspaceFilesInput>;
  threads: ReturnType<typeof createProjectWorkspaceThreadsInput>;
  runSession: Parameters<
    typeof createProjectWorkspaceRunSessionView
  >[0]['runSession'];
}

export function createProjectWorkspaceShellView({
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
  files,
  threads,
  runSession,
}: CreateProjectWorkspaceShellViewArgs): {
  leftPanelView: ReturnType<typeof createProjectWorkspaceLeftPanelView>;
  centerPanelView: ReturnType<typeof createProjectWorkspaceCenterPanelView>;
  rightPanelView: ReturnType<typeof createProjectWorkspaceRightPanelView>;
} {
  const runSessionView = createProjectWorkspaceRunSessionView({
    messages: threads.messages,
    artifacts: threads.artifacts,
    openFile: files.openFile,
    runSession,
  });

  return {
    leftPanelView: createProjectWorkspaceLeftPanelView({
      projectId,
      defaultProjectId,
      projects,
      projectRegistryError,
      projectRegistryBusy,
      onSelectProject,
      onCreateProject,
      onRenameProject,
      onDeleteProject,
      tree: files.tree,
      treeError: files.treeError,
      loadTree: files.loadTree,
      openFile: files.openFile,
      threads: threads.threads,
      selectedThreadId: threads.selectedThreadId,
      deletingThreadId: threads.deletingThreadId,
      pendingDeleteThread: threads.pendingDeleteThread,
      threadError: threads.threadError,
      loadThreads: threads.loadThreads,
      openThread: threads.openThread,
      requestDeleteThread: threads.requestDeleteThread,
      confirmDeleteThread: threads.confirmDeleteThread,
      cancelDeleteThread: threads.cancelDeleteThread,
      runSessionView,
    }),
    centerPanelView: createProjectWorkspaceCenterPanelView({
      selectedFile: files.selectedFile,
      fileContent: files.fileContent,
      isDirty: files.isDirty,
      saving: files.saving,
      editorError: files.editorError,
      saveConflict: files.saveConflict,
      handleContentChange: files.handleContentChange,
      handleSave: files.handleSave,
      handleConflictReload: files.handleConflictReload,
      handleConflictForceSave: files.handleConflictForceSave,
    }),
    rightPanelView: createProjectWorkspaceRightPanelView({
      providerAuthStatus,
      providerAuthBusy,
      providerAuthError,
      onConnectProvider,
      onDisconnectProvider,
      assistant: runSessionView.assistant,
      approvalPanel: runSessionView.approvalPanel,
    }),
  };
}
