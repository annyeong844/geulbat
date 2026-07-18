import type { ProviderAuthProviderId } from '@geulbat/protocol/provider-auth';
import type {
  ProviderAuthErrorByProvider,
  ProviderAuthStatusByProvider,
} from './use-provider-auth-state.js';

import {
  createHomeCenterPanelView,
  createHomeLeftPanelView,
  createHomeRightPanelView,
} from './home-panel-views.js';
import type { createHomeFilesInput } from './home-files-input.js';
import { createHomeRunSessionView } from './home-run-session-view.js';
import type { createHomeThreadsInput } from './home-threads-input.js';

export type ShellLayoutModeId =
  | 'default'
  | 'no-tree'
  | 'no-chat'
  | 'editor-only'
  | 'chat-center'
  | 'chat-only';

export function isShellCenterHidden(
  layoutMode: ShellLayoutModeId,
  artifactSurfaceOpen: boolean,
): boolean {
  return (
    !artifactSurfaceOpen &&
    (layoutMode === 'chat-center' || layoutMode === 'chat-only')
  );
}

export interface HomeShellProps {
  providerAuthStatuses: ProviderAuthStatusByProvider;
  providerAuthBusyProviderId: ProviderAuthProviderId | null;
  providerAuthErrors: ProviderAuthErrorByProvider;
  onConnectProvider: (
    providerId?: ProviderAuthProviderId,
  ) => Promise<void> | void;
  onDisconnectProvider: (
    providerId?: ProviderAuthProviderId,
  ) => Promise<void> | void;
}

interface CreateHomeShellViewArgs extends HomeShellProps {
  files: ReturnType<typeof createHomeFilesInput>;
  threads: ReturnType<typeof createHomeThreadsInput>;
  runSession: Parameters<typeof createHomeRunSessionView>[0]['runSession'];
}

export function createHomeShellView({
  providerAuthStatuses,
  providerAuthBusyProviderId,
  providerAuthErrors,
  onConnectProvider,
  onDisconnectProvider,
  files,
  threads,
  runSession,
}: CreateHomeShellViewArgs): {
  leftPanelView: ReturnType<typeof createHomeLeftPanelView>;
  centerPanelView: ReturnType<typeof createHomeCenterPanelView>;
  rightPanelView: ReturnType<typeof createHomeRightPanelView>;
} {
  // 과거 질문 편집 — 그 질문 "직전"까지 브랜치한 새 스레드로 전환한 뒤
  // 수정본을 명시적 threadId로 재실행한다(선택 상태 ref 레이스 회피).
  // 첫 질문 편집(fresh)은 threadId 없이 시작해 데몬이 새 스레드를 연다.
  const editPastUserPrompt = async (
    entryId: string,
    nextPrompt: string,
  ): Promise<void> => {
    const branched = await threads.branchThreadBeforeEntry(entryId);
    if (branched === null) {
      return;
    }
    await runSession.startRunRequest(
      {
        prompt: nextPrompt,
        modelId: runSession.modelId,
        permissionMode: runSession.permissionMode,
        reasoningEffort: runSession.reasoningEffort,
        subagentModelRouting: runSession.subagentModelRouting,
        ...(branched.kind === 'branched'
          ? { threadId: branched.threadId }
          : {}),
      },
      nextPrompt,
    );
  };

  const runSessionView = createHomeRunSessionView({
    messages: threads.messages,
    artifacts: threads.artifacts,
    branchFromMessage: threads.branchThreadFromEntry,
    editPastUserPrompt,
    branchNotice: threads.branchNotice,
    dismissBranchNotice: threads.dismissBranchNotice,
    runSession,
  });

  return {
    leftPanelView: createHomeLeftPanelView({
      tree: files.tree,
      treeError: files.treeError,
      selectedFile: files.selectedFile,
      browseEnabled: files.browseEnabled,
      browsePath: files.browsePath,
      browseStartPath: files.browseStartPath,
      browseShortcuts: files.browseShortcuts,
      navigateUp: files.navigateUp,
      navigateInto: files.navigateInto,
      loadTree: files.loadTree,
      loadSubtree: files.loadSubtree,
      openFile: files.openFile,
      createFile: files.createFile,
      manageEntry: files.manageEntry,
      insertFileIntoActiveBuffer: files.insertFileIntoActiveBuffer,
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
      startNewSession: threads.startNewSession,
    }),
    centerPanelView: createHomeCenterPanelView({
      selectedFile: files.selectedFile,
      extractedDocument: files.extractedDocument,
      binaryPreview: files.binaryPreview,
      fileContent: files.fileContent,
      isDirty: files.isDirty,
      saving: files.saving,
      openingFile: files.openingFile,
      lastSavedAt: files.lastSavedAt,
      editorError: files.editorError,
      saveConflict: files.saveConflict,
      openFiles: files.openFiles,
      activateTab: files.activateTab,
      closeTab: files.closeTab,
      handleContentChange: files.handleContentChange,
      handleSave: files.handleSave,
      handleConflictReload: files.handleConflictReload,
      handleConflictSaveAsCopy: files.handleConflictSaveAsCopy,
      inspectCurrentFile: files.inspectCurrentFile,
    }),
    rightPanelView: createHomeRightPanelView({
      providerAuthStatuses,
      providerAuthBusyProviderId,
      providerAuthErrors,
      onConnectProvider,
      onDisconnectProvider,
      assistant: runSessionView.assistant,
      approvalPanel: runSessionView.approvalPanel,
    }),
  };
}
