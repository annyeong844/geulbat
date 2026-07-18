import test from 'node:test';
import assert from 'node:assert/strict';

import type { ThreadSummary } from '@geulbat/protocol/threads';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import {
  createHomeCenterPanelView,
  createHomeLeftPanelView,
  createHomeRightPanelView,
} from './home-panel-views.js';
import type { createHomeRunSessionView } from './home-run-session-view.js';

type HomeRunSessionView = ReturnType<typeof createHomeRunSessionView>;

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const RUN_ID = brandRunId('run-1');

function createThreadStub(): ThreadSummary {
  return {
    threadId: THREAD_ID,
    title: 'Thread',
    lastUpdated: '2026-04-11T10:00:00.000Z',
    messageCount: 1,
  };
}

function createAssistantStub(): HomeRunSessionView['assistant'] {
  return {
    messages: [],
    artifacts: [],
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    transcriptEntries: [{ kind: 'assistant_text', text: 'hi' }],
    finalAnswerText: 'done',
    activeArtifact: null,
    onWidgetToolRequest: async () => ({ ok: true, output: 'tool-ok' }),
    streamError: null,
    isRunning: true,
    isStarting: false,
    usageTotals: null,
    contextUsage: null,
    onSend: async () => {},
    onWidgetPrompt: async () => {},
    onRegenerate: async () => {},
    onBranchFromMessage: async () => {},
    onEditPastUserPrompt: async () => {},
    branchNotice: null,
    onDismissBranchNotice: () => {},
    onCancelSteer: async () => {},
    onFlushSteers: async () => {},
    pendingSteerFlushRequested: false,
    pendingSteers: [],
    onStartArtifactRun: async () => {},
    onCancel: async () => {},
    permissionMode: 'basic' as const,
    onPermissionModeChange: () => {},
    modelId: 'gpt-5.6-sol' as const,
    onModelIdChange: () => {},
    onPrepareProviderTransition: async () => {},
    reasoningEffort: 'medium' as const,
    onReasoningEffortChange: () => {},
    subagentModelRouting: { mode: 'auto' },
    onSubagentModelRoutingChange: () => {},
  };
}

function createApprovalPanelStub(): HomeRunSessionView['approvalPanel'] {
  return {
    pending: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    permissionMode: 'basic',
    onPermissionModeChange: () => {},
    onApprove: async () => {},
    onDeny: async () => {},
  };
}

void test('createHomeLeftPanelView maps file, thread, and delete-confirm state', () => {
  const thread = createThreadStub();
  const openFile = async () => {};

  const view = createHomeLeftPanelView({
    tree: [{ name: 'draft.md', path: 'draft.md', type: 'file' }],
    treeError: 'tree failed',
    browseEnabled: false,
    browsePath: '',
    browseStartPath: '',
    browseShortcuts: [],
    navigateUp: () => {},
    navigateInto: () => {},
    selectedFile: 'draft.md',
    loadTree: async () => {},
    loadSubtree: async () => {},
    openFile,
    createFile: async () => true,
    manageEntry: async () => true,
    insertFileIntoActiveBuffer: async () => {},
    threads: [thread],
    selectedThreadId: thread.threadId,
    deletingThreadId: thread.threadId,
    pendingDeleteThread: thread,
    threadError: 'thread failed',
    loadThreads: async () => {},
    openThread: async () => {},
    requestDeleteThread: () => {},
    confirmDeleteThread: async () => {},
    cancelDeleteThread: () => {},
    startNewSession: () => {},
  });

  assert.equal(view.computerTree.onSelect, openFile);
  assert.equal(view.threadDeleteConfirm?.thread.threadId, thread.threadId);
  assert.equal(view.threadDeleteConfirm?.busy, true);
});

void test('center and right panel views pass editor, provider auth, and assistant surfaces through', () => {
  const assistant = createAssistantStub();
  const approvalPanel = createApprovalPanelStub();
  const onChange = () => {};
  const onSave = async () => {};
  const onConflictReload = async () => {};
  const onConflictSaveAsCopy = async () => {};
  const onConflictInspect = async () => null;
  const onConnectProvider = () => {};
  const onDisconnectProvider = () => {};

  const center = createHomeCenterPanelView({
    selectedFile: 'draft.md',
    binaryPreview: null,
    extractedDocument: null,
    fileContent: '# draft',
    isDirty: true,
    saving: false,
    openingFile: false,
    lastSavedAt: null,
    openFiles: [],
    activateTab: () => {},
    closeTab: () => {},
    editorError: 'editor failed',
    saveConflict: null,
    handleContentChange: onChange,
    handleSave: onSave,
    handleConflictReload: onConflictReload,
    handleConflictSaveAsCopy: onConflictSaveAsCopy,
    inspectCurrentFile: onConflictInspect,
  });
  const right = createHomeRightPanelView({
    providerAuthStatuses: {
      openai_codex_direct: {
        state: 'ready',
        ready: true,
      },
      grok_oauth: null,
    },
    providerAuthBusyProviderId: 'grok_oauth',
    providerAuthErrors: {
      openai_codex_direct: 'auth failed',
      grok_oauth: null,
    },
    onConnectProvider,
    onDisconnectProvider,
    assistant,
    approvalPanel,
  });

  assert.equal(center.editor.filePath, 'draft.md');
  assert.equal(center.editor.onChange, onChange);
  assert.equal(center.editor.onSave, onSave);
  assert.equal(center.editor.onConflictReload, onConflictReload);
  assert.equal(center.editor.onConflictSaveAsCopy, onConflictSaveAsCopy);
  assert.equal(center.editor.onConflictInspect, onConflictInspect);
  assert.equal(right.providerAuthCard.busyProviderId, 'grok_oauth');
  assert.equal(
    right.providerAuthCard.uiErrors.openai_codex_direct,
    'auth failed',
  );
  assert.equal(right.providerAuthCard.onConnect, onConnectProvider);
  assert.equal(right.providerAuthCard.onDisconnect, onDisconnectProvider);
  assert.equal(right.assistant, assistant);
  assert.equal(right.approvalPanel, approvalPanel);
});
