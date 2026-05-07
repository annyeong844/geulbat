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
  createProjectWorkspaceShellView,
  type ProjectWorkspaceProps,
} from './project-workspace-shell.js';
import { createProjectWorkspaceFilesInput } from './project-workspace-files-input.js';
import { createProjectWorkspaceThreadsInput } from './project-workspace-threads-input.js';
import { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';

const PROJECT_ID = brandProjectId('workspace');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const RUN_ID = brandRunId('run-1');

type ProjectWorkspaceRunSessionInput = Parameters<
  typeof createProjectWorkspaceRunSessionView
>[0]['runSession'];
type ProjectWorkspaceFilesInput = ReturnType<
  typeof createProjectWorkspaceFilesInput
>;
type ProjectWorkspaceThreadsInput = ReturnType<
  typeof createProjectWorkspaceThreadsInput
>;

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

function createPropsStub(): ProjectWorkspaceProps {
  return {
    projectId: PROJECT_ID,
    defaultProjectId: PROJECT_ID,
    projects: [createProjectStub()],
    projectRegistryError: 'registry failed',
    projectRegistryBusy: true,
    onSelectProject: () => {},
    onCreateProject: async () => true,
    onRenameProject: async () => true,
    onDeleteProject: async () => true,
    providerAuthStatus: {
      state: 'ready',
      ready: true,
    },
    providerAuthBusy: true,
    providerAuthError: 'auth failed',
    onConnectProvider: () => {},
    onDisconnectProvider: () => {},
  };
}

function createFilesStub(): ProjectWorkspaceFilesInput {
  return {
    tree: [{ name: 'draft.md', path: 'draft.md', type: 'file' }],
    treeError: 'tree failed',
    selectedFile: 'draft.md',
    fileContent: '# draft',
    isDirty: true,
    saveConflict: null,
    editorError: 'editor failed',
    saving: false,
    loadTree: async () => {},
    openFile: async () => {},
    handleContentChange: () => {},
    handleSave: async () => {},
    handleConflictReload: async () => {},
    handleConflictForceSave: async () => {},
  };
}

function createThreadsStub(): ProjectWorkspaceThreadsInput {
  const thread = createThreadStub();

  return {
    threads: [thread],
    threadError: 'thread failed',
    selectedThreadId: thread.threadId,
    messages: [],
    artifacts: [],
    deletingThreadId: thread.threadId,
    pendingDeleteThread: thread,
    loadThreads: async () => {},
    openThread: async () => {},
    requestDeleteThread: () => {},
    cancelDeleteThread: () => {},
    confirmDeleteThread: async () => {},
    setSelectedThreadId: () => {},
    appendOptimisticUserMessage: () => {},
  };
}

function createRunSessionStub(): ProjectWorkspaceRunSessionInput {
  return {
    isRunStarting: false,
    isRunning: true,
    transcriptEntries: [{ kind: 'assistant_text', text: 'hello' }],
    finalAnswerText: 'done',
    activeArtifact: null,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    permissionMode: 'basic',
    streamError: null,
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    setPermissionMode: () => {},
    sendPrompt: async () => {},
    startRunRequest: async () => {},
    handleApprove: async () => {},
    handleDeny: async () => {},
    handleCancel: async () => {},
  };
}

void test('createProjectWorkspaceShellView composes panel views from files, threads, provider auth, and run session inputs', () => {
  const runSession = createRunSessionStub();
  const shell = createProjectWorkspaceShellView({
    ...createPropsStub(),
    files: createFilesStub(),
    threads: createThreadsStub(),
    runSession,
  });

  assert.equal(shell.leftPanelView.projectSelector.disabled, true);
  assert.equal(
    shell.leftPanelView.projectSelector.helperText,
    'Finish or cancel the current run before switching projects.',
  );
  assert.equal(shell.leftPanelView.threadDeleteConfirm?.busy, true);
  assert.equal(shell.centerPanelView.editor.filePath, 'draft.md');
  assert.equal(shell.rightPanelView.providerAuthCard.busy, true);
  assert.equal(shell.rightPanelView.assistant.finalAnswerText, 'done');
  assert.equal(
    shell.rightPanelView.approvalPanel.pending?.callId,
    runSession.pendingApproval?.callId,
  );
});
