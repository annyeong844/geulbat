import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { FileTreeNode } from '@geulbat/protocol/files';
import type { ProviderAuthProviderId } from '@geulbat/protocol/provider-auth';
import type { ThreadSummary } from '@geulbat/protocol/threads';
import type {
  ProviderAuthErrorByProvider,
  ProviderAuthStatusByProvider,
} from './use-provider-auth-state.js';

import type { ManageFileOperation } from '../lib/api/files.js';
import type { OpenFileTab } from './use-computer-files.js';

import type { createHomeRunSessionView } from './home-run-session-view.js';

type HomeRunSessionView = ReturnType<typeof createHomeRunSessionView>;

interface HomeLeftPanelView {
  computerTree: {
    tree: FileTreeNode[];
    uiError: string | null;
    selectedPath: string | null;
    browseEnabled: boolean;
    browsePath: string;
    browseStartPath: string;
    browseShortcuts: Array<{ label: string; path: string }>;
    onNavigateUp: () => void;
    onNavigateInto: (path: string) => void;
    onLoad: () => Promise<void>;
    onLoadSubtree: (path: string) => Promise<void>;
    onSelect: (path: string) => Promise<void>;
    onCreateFile: (path: string) => Promise<boolean>;
    onManageEntry: (
      operation: ManageFileOperation,
      path: string,
      destination?: string,
    ) => Promise<boolean>;
    onInsertIntoManuscript: (path: string) => Promise<void>;
  };
  threadList: {
    threads: ThreadSummary[];
    selectedThreadId: string | null;
    deletingThreadId: string | null;
    uiError: string | null;
    onLoad: () => Promise<void>;
    onSelect: (threadId: string) => Promise<void>;
    onDeleteRequest: (threadId: string) => void;
    onNewSession: () => void;
  };
  threadDeleteConfirm: {
    thread: ThreadSummary;
    busy: boolean;
    onConfirm: () => Promise<void>;
    onCancel: () => void;
  } | null;
}

interface HomeCenterPanelView {
  editor: {
    filePath: string | null;
    extractedDocument: 'docx' | 'xlsx' | 'hwpx' | null;
    binaryPreview: {
      path: string;
      kind: 'image' | 'audio' | 'video' | 'unsupported';
      url?: string;
      byteSize?: number;
    } | null;
    content: string;
    isDirty: boolean;
    saving: boolean;
    openingFile: boolean;
    lastSavedAt: number | null;
    uiError: string | null;
    saveConflict: ConflictStaleWriteError | null;
    openFiles: OpenFileTab[];
    onSelectFileTab: (path: string) => void;
    onCloseFileTab: (path: string) => void;
    onChange: (content: string) => void;
    onSave: () => Promise<void>;
    onConflictReload: () => Promise<void>;
    onConflictSaveAsCopy: () => Promise<void>;
    onConflictInspect: () => Promise<string | null>;
  };
}

interface HomeRightPanelView {
  providerAuthCard: {
    statuses: ProviderAuthStatusByProvider;
    busyProviderId: ProviderAuthProviderId | null;
    uiErrors: ProviderAuthErrorByProvider;
    onConnect: (providerId: ProviderAuthProviderId) => Promise<void> | void;
    onDisconnect: (providerId: ProviderAuthProviderId) => Promise<void> | void;
  };
  assistant: HomeRunSessionView['assistant'];
  approvalPanel: HomeRunSessionView['approvalPanel'];
}

interface CreateHomeLeftPanelViewArgs {
  tree: FileTreeNode[];
  treeError: string | null;
  selectedFile: string | null;
  browseEnabled: boolean;
  browsePath: string;
  browseStartPath: string;
  browseShortcuts: Array<{ label: string; path: string }>;
  navigateUp: () => void;
  navigateInto: (path: string) => void;
  loadTree: () => Promise<void>;
  loadSubtree: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  createFile: (path: string) => Promise<boolean>;
  manageEntry: (
    operation: ManageFileOperation,
    path: string,
    destination?: string,
  ) => Promise<boolean>;
  insertFileIntoActiveBuffer: (path: string) => Promise<void>;
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
  startNewSession: () => void;
}

interface CreateHomeCenterPanelViewArgs {
  selectedFile: string | null;
  extractedDocument: 'docx' | 'xlsx' | 'hwpx' | null;
  binaryPreview: {
    path: string;
    kind: 'image' | 'audio' | 'video' | 'unsupported';
    url?: string;
    byteSize?: number;
  } | null;
  fileContent: string;
  isDirty: boolean;
  saving: boolean;
  openingFile: boolean;
  lastSavedAt: number | null;
  editorError: string | null;
  saveConflict: ConflictStaleWriteError | null;
  openFiles: OpenFileTab[];
  activateTab: (path: string) => void;
  closeTab: (path: string) => void;
  handleContentChange: (content: string) => void;
  handleSave: () => Promise<void>;
  handleConflictReload: () => Promise<void>;
  handleConflictSaveAsCopy: () => Promise<void>;
  inspectCurrentFile: () => Promise<string | null>;
}

interface CreateHomeRightPanelViewArgs {
  providerAuthStatuses: ProviderAuthStatusByProvider;
  providerAuthBusyProviderId: ProviderAuthProviderId | null;
  providerAuthErrors: ProviderAuthErrorByProvider;
  onConnectProvider: (
    providerId: ProviderAuthProviderId,
  ) => Promise<void> | void;
  onDisconnectProvider: (
    providerId: ProviderAuthProviderId,
  ) => Promise<void> | void;
  assistant: HomeRunSessionView['assistant'];
  approvalPanel: HomeRunSessionView['approvalPanel'];
}

export function createHomeLeftPanelView({
  tree,
  treeError,
  selectedFile,
  browseEnabled,
  browsePath,
  browseStartPath,
  browseShortcuts,
  navigateUp,
  navigateInto,
  loadTree,
  loadSubtree,
  openFile,
  createFile,
  manageEntry,
  insertFileIntoActiveBuffer,
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
  startNewSession,
}: CreateHomeLeftPanelViewArgs): HomeLeftPanelView {
  return {
    computerTree: {
      tree,
      uiError: treeError,
      selectedPath: selectedFile,
      browseEnabled,
      browsePath,
      browseStartPath,
      browseShortcuts,
      onNavigateUp: navigateUp,
      onNavigateInto: navigateInto,
      onLoad: loadTree,
      onLoadSubtree: loadSubtree,
      onSelect: openFile,
      onCreateFile: createFile,
      onManageEntry: manageEntry,
      onInsertIntoManuscript: insertFileIntoActiveBuffer,
    },
    threadList: {
      threads,
      selectedThreadId,
      deletingThreadId,
      uiError: threadError,
      onLoad: loadThreads,
      onSelect: openThread,
      onDeleteRequest: requestDeleteThread,
      onNewSession: startNewSession,
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

export function createHomeCenterPanelView({
  selectedFile,
  extractedDocument,
  binaryPreview,
  fileContent,
  isDirty,
  saving,
  openingFile,
  lastSavedAt,
  editorError,
  saveConflict,
  openFiles,
  activateTab,
  closeTab,
  handleContentChange,
  handleSave,
  handleConflictReload,
  handleConflictSaveAsCopy,
  inspectCurrentFile,
}: CreateHomeCenterPanelViewArgs): HomeCenterPanelView {
  return {
    editor: {
      filePath: selectedFile,
      extractedDocument,
      binaryPreview,
      content: fileContent,
      isDirty,
      saving,
      openingFile,
      lastSavedAt,
      uiError: editorError,
      saveConflict,
      openFiles,
      onSelectFileTab: activateTab,
      onCloseFileTab: closeTab,
      onChange: handleContentChange,
      onSave: handleSave,
      onConflictReload: handleConflictReload,
      onConflictSaveAsCopy: handleConflictSaveAsCopy,
      onConflictInspect: inspectCurrentFile,
    },
  };
}

export function createHomeRightPanelView({
  providerAuthStatuses,
  providerAuthBusyProviderId,
  providerAuthErrors,
  onConnectProvider,
  onDisconnectProvider,
  assistant,
  approvalPanel,
}: CreateHomeRightPanelViewArgs): HomeRightPanelView {
  return {
    providerAuthCard: {
      statuses: providerAuthStatuses,
      busyProviderId: providerAuthBusyProviderId,
      uiErrors: providerAuthErrors,
      onConnect: onConnectProvider,
      onDisconnect: onDisconnectProvider,
    },
    assistant,
    approvalPanel,
  };
}
