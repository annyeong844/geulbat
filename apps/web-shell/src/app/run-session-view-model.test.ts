import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { createRunSessionViewModel } from './run-session-view-model.js';
import { createEmptyActiveRunView } from './run-session-state-types.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

void test('createRunSessionViewModel combines visible projection with controller actions', async () => {
  const seen: string[] = [];
  const pendingApproval = makeApprovalRequiredFixture({
    runId: RUN_ID,
    threadId: THREAD_ID,
  });

  const viewModel = createRunSessionViewModel({
    selectedThreadId: THREAD_ID_VALUE,
    state: {
      phase: 'running',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: RUN_ID,
        transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
        finalAnswerText: 'final',
        pendingApproval,
        streamError: '[internal] failed',
      },
      sessionError: null,
      backgroundNotificationsByThread: {
        [THREAD_ID_VALUE]: [
          {
            kind: 'subagent_activity',
            childRunId: 'run-child-1',
            subagentType: 'worker',
            state: 'failed',
          },
        ],
      },
    },
    permissionMode: 'full_access',
    setPermissionMode: () => {
      seen.push('setPermissionMode');
    },
    sendPrompt: async () => {
      seen.push('sendPrompt');
    },
    startRunRequest: async () => {
      seen.push('startRunRequest');
    },
    handleApprove: async () => {
      seen.push('handleApprove');
    },
    handleDeny: async () => {
      seen.push('handleDeny');
    },
    handleCancel: async () => {
      seen.push('handleCancel');
    },
  });

  assert.equal(viewModel.visibleThreadId, THREAD_ID_VALUE);
  assert.equal(viewModel.activeRunId, RUN_ID);
  assert.equal(viewModel.isRunStarting, false);
  assert.equal(viewModel.isRunning, true);
  assert.deepEqual(viewModel.transcriptEntries, [
    { kind: 'assistant_text', text: 'commentary' },
  ]);
  assert.equal(viewModel.finalAnswerText, 'final');
  assert.equal(viewModel.pendingApproval?.threadId, THREAD_ID_VALUE);
  assert.equal(viewModel.streamError, '[internal] failed');
  assert.deepEqual(viewModel.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'failed',
    },
  ]);

  viewModel.setPermissionMode('basic');
  await viewModel.sendPrompt('prompt');
  await viewModel.startRunRequest({
    prompt: 'prompt',
    projectId: 'project-1' as never,
  });
  await viewModel.handleApprove(pendingApproval, 'session');
  await viewModel.handleDeny(pendingApproval);
  await viewModel.handleCancel();

  assert.deepEqual(seen, [
    'setPermissionMode',
    'sendPrompt',
    'startRunRequest',
    'handleApprove',
    'handleDeny',
    'handleCancel',
  ]);
});
