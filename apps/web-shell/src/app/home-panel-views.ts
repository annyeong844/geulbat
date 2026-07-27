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

import type { ComputerTreeProps } from '../features/computer-tree/ComputerTree.js';
import type { EditorProps } from '../features/editor/Editor.js';
import type { ProviderAuthCardProps } from '../features/provider-auth/ProviderAuthCard.js';
import type { ThreadDeleteConfirmProps } from '../features/thread-list/ThreadDeleteConfirm.js';
import type { ThreadListProps } from '../features/thread-list/ThreadList.js';

import type { createHomeRunSessionView } from './home-run-session-view.js';

type HomeRunSessionView = ReturnType<typeof createHomeRunSessionView>;

// 각 슬롯은 컴포넌트 owner 계약에서 파생한다 — 여기서 필드를 다시 선언하지
// 않으므로 owner가 prop을 바꾸면 이 view가 함께 따라간다. `Omit` 키는
// HomeShell이 호출부에서 직접 배선하는 prop을 명시한다.
interface HomeLeftPanelView {
  computerTree: Required<Omit<ComputerTreeProps, 'favoriteDirectories'>>;
  threadList: Required<
    Omit<ThreadListProps, 'onOpenManager' | 'onRenameRequest' | 'onTogglePin'>
  >;
  // ThreadList prop이 아니다 — 세션 매니저와 레일 버튼이 쓰는 shell 액션이라
  // 목록 계약 밖에 둔다.
  onNewSession: () => void;
  threadDeleteConfirm: ThreadDeleteConfirmProps | null;
}

interface HomeCenterPanelView {
  providerAuthCard: Required<ProviderAuthCardProps>;
  // HomeShell이 호출부에서 직접 배선하는 prop(읽기전용 여부, 최근 파일,
  // 폴더/최근파일 조작, 아티팩트 표면)은 여기서 제외한다.
  editor: Required<
    Omit<
      EditorProps,
      | 'readOnly'
      | 'recentFiles'
      | 'onOpenFolder'
      | 'onOpenRecentFile'
      | 'onRemoveRecentFile'
      | 'artifactPill'
      | 'artifactSurface'
    >
  >;
}

interface HomeRightPanelView {
  assistant: HomeRunSessionView['assistant'];
  approvalPanel: HomeRunSessionView['approvalPanel'];
  streamingArtifactText: HomeRunSessionView['streamingArtifactText'];
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
  exportingThreadId: string | null;
  importingThreadArchive: boolean;
  threadTransferNotice: string | null;
  threadError: string | null;
  loadThreads: () => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  requestDeleteThread: (threadId: string) => void;
  confirmDeleteThread: () => Promise<void>;
  cancelDeleteThread: () => void;
  exportThread: (threadId: string) => Promise<void>;
  importThread: (archive: Blob) => Promise<void>;
  startNewSession: () => void;
}

interface CreateHomeCenterPanelViewArgs {
  providerAuthStatuses: ProviderAuthStatusByProvider;
  providerAuthBusyProviderId: ProviderAuthProviderId | null;
  providerAuthErrors: ProviderAuthErrorByProvider;
  onConnectProvider: (
    providerId: ProviderAuthProviderId,
  ) => Promise<void> | void;
  onDisconnectProvider: (
    providerId: ProviderAuthProviderId,
  ) => Promise<void> | void;
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
  assistant: HomeRunSessionView['assistant'];
  approvalPanel: HomeRunSessionView['approvalPanel'];
  streamingArtifactText: HomeRunSessionView['streamingArtifactText'];
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
  exportingThreadId,
  importingThreadArchive,
  threadTransferNotice,
  threadError,
  loadThreads,
  openThread,
  requestDeleteThread,
  confirmDeleteThread,
  cancelDeleteThread,
  exportThread,
  importThread,
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
      exportingThreadId,
      importingThreadArchive,
      transferNotice: threadTransferNotice,
      uiError: threadError,
      onLoad: loadThreads,
      onSelect: openThread,
      onDeleteRequest: requestDeleteThread,
      onExport: exportThread,
      onImport: importThread,
    },
    onNewSession: startNewSession,
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
  providerAuthStatuses,
  providerAuthBusyProviderId,
  providerAuthErrors,
  onConnectProvider,
  onDisconnectProvider,
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
    providerAuthCard: {
      statuses: providerAuthStatuses,
      busyProviderId: providerAuthBusyProviderId,
      uiErrors: providerAuthErrors,
      onConnect: onConnectProvider,
      onDisconnect: onDisconnectProvider,
    },
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
  assistant,
  approvalPanel,
  streamingArtifactText,
}: CreateHomeRightPanelViewArgs): HomeRightPanelView {
  return {
    assistant,
    approvalPanel,
    streamingArtifactText,
  };
}
