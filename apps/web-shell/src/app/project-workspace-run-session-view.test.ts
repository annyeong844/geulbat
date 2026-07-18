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
    modelId: 'grok-4.5',
    reasoningEffort: 'medium',
    subagentModelRouting: { mode: 'auto' },
    setPermissionMode: () => {},
    setModelId: () => {},
    prepareProviderTransition: async () => {},
    setReasoningEffort: () => {},
    setSubagentModelRouting: () => {},
    requestWidgetTool: async () => ({ ok: true, output: 'tool-ok' }),
    streamError: '[internal] failed',
    usageTotals: null,
    contextUsage: {
      state: 'measured',
      modelId: 'grok-4.5',
      inputTokens: 212_500,
      contextWindow: 500_000,
      thresholdTokens: 425_000,
    },
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    sendPrompt: async () => {},
    sendWidgetPrompt: async () => {},
    regeneratePrompt: async () => {},
    cancelSteer: async () => {},
    flushSteers: async () => {},
    pendingSteers: [],
    pendingSteerFlushRequested: true,
    startRunRequest: async () => {},
    handleApprove: async () => {},
    handleDeny: async () => {},
    handleCancel: async () => {},
    ...overrides,
  };
}

void test('createProjectWorkspaceRunSessionView derives assistant presentation props', () => {
  const runSession = createRunSessionViewModelStub();
  const branchFromMessage = async () => {};

  const dismissBranchNotice = () => {};
  const editPastUserPrompt = async () => {};

  const view = createProjectWorkspaceRunSessionView({
    messages: [],
    artifacts: [],
    branchFromMessage,
    editPastUserPrompt,
    branchNotice: '⑂ 새 채팅으로 전환했습니다',
    dismissBranchNotice,
    runSession,
  });

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
  assert.equal(view.assistant.modelId, 'grok-4.5');
  assert.equal(view.assistant.contextUsage?.inputTokens, 212_500);
  assert.equal(
    view.assistant.onPrepareProviderTransition,
    runSession.prepareProviderTransition,
  );
  assert.equal(view.assistant.pendingSteerFlushRequested, true);
  assert.equal(typeof view.assistant.onFlushSteers, 'function');
  assert.equal(view.assistant.onBranchFromMessage, branchFromMessage);
  assert.equal(view.assistant.onEditPastUserPrompt, editPastUserPrompt);
  assert.equal(view.assistant.branchNotice, '⑂ 새 채팅으로 전환했습니다');
  assert.equal(view.assistant.onDismissBranchNotice, dismissBranchNotice);
  assert.equal(view.approvalPanel.onApprove, runSession.handleApprove);
});
