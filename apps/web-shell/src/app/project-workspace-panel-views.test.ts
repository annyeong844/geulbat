import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectListItem } from '@geulbat/protocol/projects';
import type { ThreadSummary } from '@geulbat/protocol/threads';

import {
  brandProjectId,
  brandRunId,
  brandThreadId,
} from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import {
  createProjectWorkspaceCenterPanelView,
  createProjectWorkspaceLeftPanelView,
  createProjectWorkspaceRightPanelView,
} from './project-workspace-panel-views.js';
import type { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';

type ProjectWorkspaceRunSessionView = ReturnType<
  typeof createProjectWorkspaceRunSessionView
>;

const PROJECT_ID = brandProjectId('workspace');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const RUN_ID = brandRunId('run-1');

function createProjectStub(): ProjectListItem {
  return {
    projectId: PROJECT_ID,
    label: 'Workspace',
  };
}

function createThreadStub(): ThreadSummary {
  return {
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: 'Thread',
    lastUpdated: '2026-04-11T10:00:00.000Z',
    messageCount: 1,
  };
}

function createAssistantStub(): ProjectWorkspaceRunSessionView['assistant'] {
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
    streamError: null,
    isRunning: true,
    onOpenSource: async () => {},
    onSend: async () => {},
    onStartArtifactRun: async () => {},
    onCancel: async () => {},
  };
}

function createApprovalPanelStub(): ProjectWorkspaceRunSessionView['approvalPanel'] {
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

void test('createProjectWorkspaceLeftPanelView maps project gating and delete-confirm busy state', () => {
  const project = createProjectStub();
  const thread = createThreadStub();
  const openFile = async () => {};

  const view = createProjectWorkspaceLeftPanelView({
    projectId: project.projectId,
    defaultProjectId: project.projectId,
    projects: [project],
    projectRegistryError: 'registry failed',
    projectRegistryBusy: true,
    onSelectProject: () => {},
    onCreateProject: async () => true,
    onRenameProject: async () => true,
    onDeleteProject: async () => true,
    tree: [{ name: 'draft.md', path: 'draft.md', type: 'file' }],
    treeError: 'tree failed',
    loadTree: async () => {},
    openFile,
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
    runSessionView: {
      isProjectSwitchBlocked: true,
      projectSelectorHelperText:
        'Finish or cancel the current run before switching projects.',
      projectRegistryHelperText:
        'Finish or cancel the current run before managing projects.',
    },
  });

  assert.equal(view.projectSelector.disabled, true);
  assert.equal(
    view.projectSelector.helperText,
    'Finish or cancel the current run before switching projects.',
  );
  assert.equal(view.projectRegistry.disabled, true);
  assert.equal(view.projectRegistry.busy, true);
  assert.equal(view.projectTree.onSelect, openFile);
  assert.equal(view.threadDeleteConfirm?.thread.threadId, thread.threadId);
  assert.equal(view.threadDeleteConfirm?.busy, true);
});

void test('center and right panel views pass editor, provider auth, and assistant surfaces through', () => {
  const assistant = createAssistantStub();
  const approvalPanel = createApprovalPanelStub();
  const onChange = () => {};
  const onSave = async () => {};
  const onConflictReload = async () => {};
  const onConflictForceSave = async () => {};
  const onConnectProvider = () => {};
  const onDisconnectProvider = () => {};

  const center = createProjectWorkspaceCenterPanelView({
    selectedFile: 'draft.md',
    fileContent: '# draft',
    isDirty: true,
    saving: false,
    editorError: 'editor failed',
    saveConflict: null,
    handleContentChange: onChange,
    handleSave: onSave,
    handleConflictReload: onConflictReload,
    handleConflictForceSave: onConflictForceSave,
  });
  const right = createProjectWorkspaceRightPanelView({
    providerAuthStatus: {
      state: 'ready',
      ready: true,
    },
    providerAuthBusy: true,
    providerAuthError: 'auth failed',
    onConnectProvider,
    onDisconnectProvider,
    assistant,
    approvalPanel,
  });

  assert.equal(center.editor.filePath, 'draft.md');
  assert.equal(center.editor.onChange, onChange);
  assert.equal(center.editor.onSave, onSave);
  assert.equal(center.editor.onConflictReload, onConflictReload);
  assert.equal(center.editor.onConflictForceSave, onConflictForceSave);
  assert.equal(right.providerAuthCard.busy, true);
  assert.equal(right.providerAuthCard.uiError, 'auth failed');
  assert.equal(right.providerAuthCard.onConnect, onConnectProvider);
  assert.equal(right.providerAuthCard.onDisconnect, onDisconnectProvider);
  assert.equal(right.assistant, assistant);
  assert.equal(right.approvalPanel, approvalPanel);
});
