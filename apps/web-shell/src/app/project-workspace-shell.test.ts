import test from 'node:test';
import assert from 'node:assert/strict';

import type { ThreadSummary } from '@geulbat/protocol/threads';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import {
  createProjectWorkspaceShellView,
  isWorkspaceCenterHidden,
  type ProjectWorkspaceProps,
} from './project-workspace-shell.js';
import { createProjectWorkspaceFilesInput } from './project-workspace-files-input.js';
import { createProjectWorkspaceThreadsInput } from './project-workspace-threads-input.js';
import { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';

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

function createThreadStub(): ThreadSummary {
  return {
    threadId: THREAD_ID,
    title: 'Thread',
    lastUpdated: '2026-04-11T10:00:00.000Z',
    messageCount: 1,
  };
}

function createPropsStub(): ProjectWorkspaceProps {
  return {
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
    onConnectProvider: () => {},
    onDisconnectProvider: () => {},
  };
}

function createFilesStub(): ProjectWorkspaceFilesInput {
  return {
    tree: [{ name: 'draft.md', path: 'draft.md', type: 'file' }],
    treeError: 'tree failed',
    browseEnabled: false,
    browsePath: '',
    browseStartPath: '',
    browseShortcuts: [],
    binaryPreview: null,
    extractedDocument: null,
    navigateUp: () => {},
    navigateInto: () => {},
    selectedFile: 'draft.md',
    fileContent: '# draft',
    isDirty: true,
    saveConflict: null,
    editorError: 'editor failed',
    saving: false,
    openingFile: false,
    lastSavedAt: null,
    openFiles: [],
    loadTree: async () => {},
    loadSubtree: async () => {},
    openFile: async () => {},
    activateTab: () => {},
    closeTab: () => {},
    createFile: async () => true,
    manageEntry: async () => true,
    insertFileIntoActiveBuffer: async () => {},
    handleContentChange: () => {},
    handleSave: async () => {},
    handleConflictReload: async () => {},
    handleConflictSaveAsCopy: async () => {},
    inspectCurrentFile: async () => null,
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
    startNewSession: () => {},
    branchThreadFromEntry: async () => {},
    branchThreadBeforeEntry: async () => null,
    branchNotice: null,
    dismissBranchNotice: () => {},
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
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    subagentModelRouting: { mode: 'auto' },
    streamError: null,
    usageTotals: null,
    contextUsage: null,
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    setPermissionMode: () => {},
    setModelId: () => {},
    prepareProviderTransition: async () => {},
    setReasoningEffort: () => {},
    setSubagentModelRouting: () => {},
    sendPrompt: async () => {},
    sendWidgetPrompt: async () => {},
    requestWidgetTool: async () => ({ ok: true, output: 'tool-ok' }),
    regeneratePrompt: async () => {},
    cancelSteer: async () => {},
    flushSteers: async () => {},
    pendingSteerFlushRequested: false,
    pendingSteers: [],
    startRunRequest: async () => {},
    handleApprove: async () => {},
    handleDeny: async () => {},
    handleCancel: async () => {},
  };
}

void test('an open artifact temporarily reveals the center from chat-only layout', () => {
  assert.equal(isWorkspaceCenterHidden('chat-only', false), true);
  assert.equal(isWorkspaceCenterHidden('chat-only', true), false);
  assert.equal(isWorkspaceCenterHidden('no-tree', false), false);
});

void test('createProjectWorkspaceShellView composes panel views from files, threads, provider auth, and run session inputs', () => {
  const runSession = createRunSessionStub();
  const shell = createProjectWorkspaceShellView({
    ...createPropsStub(),
    files: createFilesStub(),
    threads: createThreadsStub(),
    runSession,
  });

  assert.equal(shell.leftPanelView.threadDeleteConfirm?.busy, true);
  assert.equal(shell.centerPanelView.editor.filePath, 'draft.md');
  assert.equal(
    shell.rightPanelView.providerAuthCard.busyProviderId,
    'grok_oauth',
  );
  assert.equal(shell.rightPanelView.assistant.finalAnswerText, 'done');
  assert.equal(
    shell.rightPanelView.approvalPanel.pending?.callId,
    runSession.pendingApproval?.callId,
  );
});

void test('createProjectWorkspaceShellView edits a past question by branching before it and rerunning', async () => {
  const branchCalls: string[] = [];
  const startCalls: Array<{ request: unknown; optimisticPrompt?: string }> = [];
  const branchedThreadId = brandThreadId(
    '00000000-0000-4000-8000-000000000009',
  );
  const runSession = {
    ...createRunSessionStub(),
    startRunRequest: async (request: unknown, optimisticPrompt?: string) => {
      startCalls.push({
        request,
        ...(optimisticPrompt !== undefined ? { optimisticPrompt } : {}),
      });
    },
  };
  const shell = createProjectWorkspaceShellView({
    ...createPropsStub(),
    files: createFilesStub(),
    threads: {
      ...createThreadsStub(),
      branchThreadBeforeEntry: async (entryId: string) => {
        branchCalls.push(entryId);
        return { kind: 'branched' as const, threadId: branchedThreadId };
      },
    },
    runSession,
  });

  await shell.rightPanelView.assistant.onEditPastUserPrompt(
    'entry-past-question',
    '고친 질문',
  );

  assert.deepEqual(branchCalls, ['entry-past-question']);
  assert.equal(startCalls.length, 1);
  const request = startCalls[0]?.request as {
    prompt: string;
    threadId?: string;
  };
  assert.equal(request.prompt, '고친 질문');
  assert.equal(request.threadId, branchedThreadId);
  assert.equal(startCalls[0]?.optimisticPrompt, '고친 질문');
});

void test('createProjectWorkspaceShellView skips the rerun when the edit branch fails', async () => {
  const startCalls: unknown[] = [];
  const shell = createProjectWorkspaceShellView({
    ...createPropsStub(),
    files: createFilesStub(),
    threads: {
      ...createThreadsStub(),
      branchThreadBeforeEntry: async () => null,
    },
    runSession: {
      ...createRunSessionStub(),
      startRunRequest: async (request: unknown) => {
        startCalls.push(request);
      },
    },
  });

  await shell.rightPanelView.assistant.onEditPastUserPrompt(
    'entry-past-question',
    '고친 질문',
  );

  assert.equal(startCalls.length, 0);
});
