import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

type ProjectWorkspaceRunSessionInput = Parameters<
  typeof createProjectWorkspaceRunSessionView
>[0]['runSession'];

function createRunSessionViewModelStub(
  overrides: Partial<ProjectWorkspaceRunSessionInput> = {},
): ProjectWorkspaceRunSessionInput {
  return {
    isRunStarting: false,
    isRunning: true,
    transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
    finalAnswerText: 'final',
    activeArtifact: null,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    permissionMode: 'basic',
    setPermissionMode: () => {},
    streamError: '[internal] failed',
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    sendPrompt: async () => {},
    startRunRequest: async () => {},
    handleApprove: async () => {},
    handleDeny: async () => {},
    handleCancel: async () => {},
    ...overrides,
  };
}

void test('createProjectWorkspaceRunSessionView derives project guard state and assistant presentation props', () => {
  const runSession = createRunSessionViewModelStub();
  const openFile = async () => {};

  const view = createProjectWorkspaceRunSessionView({
    messages: [],
    artifacts: [],
    openFile,
    runSession,
  });

  assert.equal(view.isProjectSwitchBlocked, true);
  assert.equal(
    view.projectSelectorHelperText,
    'Finish or cancel the current run before switching projects.',
  );
  assert.equal(
    view.projectRegistryHelperText,
    'Finish or cancel the current run before managing projects.',
  );
  assert.equal(view.assistant.onOpenSource, openFile);
  assert.deepEqual(view.assistant.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
  assert.deepEqual(view.assistant.transcriptEntries, [
    { kind: 'assistant_text', text: 'commentary' },
  ]);
  assert.equal(
    view.approvalPanel.pending?.callId,
    runSession.pendingApproval?.callId,
  );
  assert.equal(view.approvalPanel.permissionMode, 'basic');
  assert.equal(view.approvalPanel.onApprove, runSession.handleApprove);
});

void test('createProjectWorkspaceRunSessionView clears project helper text when no run is active', () => {
  const view = createProjectWorkspaceRunSessionView({
    messages: [],
    artifacts: [],
    openFile: async () => {},
    runSession: createRunSessionViewModelStub({
      isRunStarting: false,
      isRunning: false,
      pendingApproval: null,
      streamError: null,
      backgroundNotifications: [],
      transcriptEntries: [],
      finalAnswerText: '',
    }),
  });

  assert.equal(view.isProjectSwitchBlocked, false);
  assert.equal(view.projectSelectorHelperText, null);
  assert.equal(view.projectRegistryHelperText, null);
});
