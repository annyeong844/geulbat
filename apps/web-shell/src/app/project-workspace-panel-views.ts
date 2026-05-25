import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { FileTreeNode } from '@geulbat/protocol/files';
import type { ProjectListItem } from '@geulbat/protocol/projects';
import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';
import type { ThreadSummary } from '@geulbat/protocol/threads';

import type { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';

type ProjectWorkspaceRunSessionView = ReturnType<
  typeof createProjectWorkspaceRunSessionView
>;

interface ProjectWorkspaceLeftPanelView {
  projectSelector: {
    projects: ProjectListItem[];
    selectedProjectId: string;
    disabled: boolean;
    uiError: string | null;
    helperText: string | null;
    onSelect: (projectId: string) => void;
  };
  projectRegistry: {
    projects: ProjectListItem[];
    defaultProjectId: string;
    selectedProjectId: string;
    disabled: boolean;
    busy: boolean;
    helperText: string | null;
    onCreate: (label: string) => Promise<boolean>;
    onRename: (projectId: string, label: string) => Promise<boolean>;
    onDelete: (projectId: string) => Promise<boolean>;
  };
  projectTree: {
    tree: FileTreeNode[];
    uiError: string | null;
    onLoad: () => Promise<void>;
    onSelect: (path: string) => Promise<void>;
  };
  threadList: {
    threads: ThreadSummary[];
    selectedThreadId: string | null;
    deletingThreadId: string | null;
    uiError: string | null;
    onLoad: () => Promise<void>;
    onSelect: (threadId: string) => Promise<void>;
    onDeleteRequest: (threadId: string) => void;
  };
  threadDeleteConfirm: {
    thread: ThreadSummary;
    busy: boolean;
    onConfirm: () => Promise<void>;
    onCancel: () => void;
  } | null;
}

interface ProjectWorkspaceCenterPanelView {
  editor: {
    filePath: string | null;
    content: string;
    isDirty: boolean;
    saving: boolean;
    uiError: string | null;
    saveConflict: ConflictStaleWriteError | null;
    onChange: (content: string) => void;
    onSave: () => Promise<void>;
    onConflictReload: () => Promise<void>;
    onConflictForceSave: () => Promise<void>;
  };
}

interface ProjectWorkspaceRightPanelView {
  providerAuthCard: {
    status: ProviderAuthStatusResponse | null;
    busy: boolean;
    uiError: string | null;
    onConnect: () => Promise<void> | void;
    onDisconnect: () => Promise<void> | void;
  };
  assistant: ProjectWorkspaceRunSessionView['assistant'];
  approvalPanel: ProjectWorkspaceRunSessionView['approvalPanel'];
}

interface CreateProjectWorkspaceLeftPanelViewArgs {
  projectId: string;
  defaultProjectId: string;
  projects: ProjectListItem[];
  projectRegistryError: string | null;
  projectRegistryBusy: boolean;
  onSelectProject: (projectId: string) => void;
  onCreateProject: (label: string) => Promise<boolean>;
  onRenameProject: (projectId: string, label: string) => Promise<boolean>;
  onDeleteProject: (projectId: string) => Promise<boolean>;
  tree: FileTreeNode[];
  treeError: string | null;
  loadTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  deletingThreadId: string | null;
  pendingDeleteThread: ThreadSummary | null;
  threadError: string | null;
  loadThreads: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  requestDeleteThread: (threadId: string) => void;
  confirmDeleteThread: () => Promise<void>;
  cancelDeleteThread: () => void;
  runSessionView: Pick<
    ProjectWorkspaceRunSessionView,
    | 'isProjectSwitchBlocked'
    | 'projectSelectorHelperText'
    | 'projectRegistryHelperText'
  >;
}

interface CreateProjectWorkspaceCenterPanelViewArgs {
  selectedFile: string | null;
  fileContent: string;
  isDirty: boolean;
  saving: boolean;
  editorError: string | null;
  saveConflict: ConflictStaleWriteError | null;
  handleContentChange: (content: string) => void;
  handleSave: () => Promise<void>;
  handleConflictReload: () => Promise<void>;
  handleConflictForceSave: () => Promise<void>;
}

interface CreateProjectWorkspaceRightPanelViewArgs {
  providerAuthStatus: ProviderAuthStatusResponse | null;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  onConnectProvider: () => Promise<void> | void;
  onDisconnectProvider: () => Promise<void> | void;
  assistant: ProjectWorkspaceRunSessionView['assistant'];
  approvalPanel: ProjectWorkspaceRunSessionView['approvalPanel'];
}

export function createProjectWorkspaceLeftPanelView({
  projectId,
  defaultProjectId,
  projects,
  projectRegistryError,
  projectRegistryBusy,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  tree,
  treeError,
  loadTree,
  openFile,
  threads,
  selectedThreadId,
  deletingThreadId,
  pendingDeleteThread,
  threadError,
  loadThreads,
  openThread,
  requestDeleteThread,
  confirmDeleteThread,
  cancelDeleteThread,
  runSessionView,
}: CreateProjectWorkspaceLeftPanelViewArgs): ProjectWorkspaceLeftPanelView {
  return {
    projectSelector: {
      projects,
      selectedProjectId: projectId,
      disabled: runSessionView.isProjectSwitchBlocked,
      uiError: projectRegistryError,
      helperText: runSessionView.projectSelectorHelperText,
      onSelect: onSelectProject,
    },
    projectRegistry: {
      projects,
      defaultProjectId,
      selectedProjectId: projectId,
      disabled: runSessionView.isProjectSwitchBlocked,
      busy: projectRegistryBusy,
      helperText: runSessionView.projectRegistryHelperText,
      onCreate: onCreateProject,
      onRename: onRenameProject,
      onDelete: onDeleteProject,
    },
    projectTree: {
      tree,
      uiError: treeError,
      onLoad: loadTree,
      onSelect: openFile,
    },
    threadList: {
      threads,
      selectedThreadId,
      deletingThreadId,
      uiError: threadError,
      onLoad: loadThreads,
      onSelect: openThread,
      onDeleteRequest: requestDeleteThread,
    },
    threadDeleteConfirm: pendingDeleteThread
      ? {
          thread: pendingDeleteThread,
          busy: deletingThreadId === pendingDeleteThread.threadId,
          onConfirm: confirmDeleteThread,
          onCancel: cancelDeleteThread,
        }
      : null,
  };
}

export function createProjectWorkspaceCenterPanelView({
  selectedFile,
  fileContent,
  isDirty,
  saving,
  editorError,
  saveConflict,
  handleContentChange,
  handleSave,
  handleConflictReload,
  handleConflictForceSave,
}: CreateProjectWorkspaceCenterPanelViewArgs): ProjectWorkspaceCenterPanelView {
  return {
    editor: {
      filePath: selectedFile,
      content: fileContent,
      isDirty,
      saving,
      uiError: editorError,
      saveConflict,
      onChange: handleContentChange,
      onSave: handleSave,
      onConflictReload: handleConflictReload,
      onConflictForceSave: handleConflictForceSave,
    },
  };
}

export function createProjectWorkspaceRightPanelView({
  providerAuthStatus,
  providerAuthBusy,
  providerAuthError,
  onConnectProvider,
  onDisconnectProvider,
  assistant,
  approvalPanel,
}: CreateProjectWorkspaceRightPanelViewArgs): ProjectWorkspaceRightPanelView {
  return {
    providerAuthCard: {
      status: providerAuthStatus,
      busy: providerAuthBusy,
      uiError: providerAuthError,
      onConnect: onConnectProvider,
      onDisconnect: onDisconnectProvider,
    },
    assistant,
    approvalPanel,
  };
}
