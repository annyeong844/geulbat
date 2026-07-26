import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { createHomeRunSessionView } from './home-run-session-view.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

type HomeRunSessionInput = Parameters<
  typeof createHomeRunSessionView
>[0]['runSession'];

function createRunSessionViewModelStub(
  overrides: Partial<HomeRunSessionInput> = {},
): HomeRunSessionInput {
  return {
    visibleThreadId: THREAD_ID,
    isRunStarting: false,
    isRunning: true,
    transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
    finalAnswerText: 'final',
    streamingArtifactText: '',
    activeArtifact: null,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    permissionMode: 'basic',
    modelId: 'grok-4.5',
    reasoningEffort: 'medium',
    serviceTier: 'standard',
    subagentModelRouting: { mode: 'auto' },
    setPermissionMode: async () => {},
    planModeRequested: false,
    setPlanModeRequested: () => {},
    planModeIntensity: 'visual',
    setPlanModeIntensity: () => {},
    planModeDepth: 'standard',
    setPlanModeDepth: () => {},
    planningWorkflow: null,
    followupSuggestion: null,
    dismissFollowupSuggestion: () => {},
    setModelId: () => {},
    prepareProviderTransition: async () => {},
    setReasoningEffort: () => {},
    setServiceTier: () => {},
    setSubagentModelRouting: () => {},
    requestWidgetTool: async () => ({ ok: true, output: 'tool-ok' }),
    streamError: '[internal] failed',
    streamErrorCode: 'internal',
    usageTotals: null,
    providerRuntime: {
      phase: 'rate_limit_waiting',
      observedAt: '2026-07-23T11:00:00.000Z',
    },
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
    sendPromptAsNewTurn: async () => {},
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
    stopChildRun: async () => {},
    ...overrides,
    workingDirectory: overrides.workingDirectory ?? null,
    setWorkingDirectory: overrides.setWorkingDirectory ?? (() => {}),
    goal: overrides.goal ?? null,
  };
}

void test('createHomeRunSessionView derives assistant presentation props', () => {
  const runSession = createRunSessionViewModelStub();
  const branchFromMessage = async () => {};

  const dismissBranchNotice = () => {};
  const editPastUserPrompt = async () => {};

  const view = createHomeRunSessionView({
    messages: [],
    artifacts: [],
    subagentTerminalOutcomes: [
      {
        deliveryId: 'delivery-history',
        parentRunId: RUN_ID,
        childRunId: brandRunId('run-child-history'),
        childThreadId: THREAD_ID,
        subagentType: 'worker',
        terminalState: 'failed',
        reason: 'daemon_restart',
        result: 'partial history',
        completedAt: '2026-07-23T10:00:00.000Z',
      },
    ],
    branchFromMessage,
    editPastUserPrompt,
    branchNotice: '⑂ 새 채팅으로 전환했습니다',
    dismissBranchNotice,
    runSession,
  });

  assert.deepEqual(view.assistant.activity.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
  assert.deepEqual(view.assistant.conversation.transcriptEntries, [
    { kind: 'assistant_text', text: 'commentary' },
  ]);
  assert.deepEqual(view.assistant.activity.subagentTerminalHistoryEntries, [
    {
      kind: 'subagent_activity',
      deliveryId: 'delivery-history',
      parentRunId: RUN_ID,
      childRunId: 'run-child-history',
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      state: 'failed',
      reason: 'daemon_restart',
      result: 'partial history',
      completedAt: '2026-07-23T10:00:00.000Z',
    },
  ]);
  assert.deepEqual(view.assistant.runState, {
    streamError: runSession.streamError,
    streamErrorCode: runSession.streamErrorCode,
    isRunning: runSession.isRunning,
    isStarting: runSession.isRunStarting,
    isSettling: false,
    usageTotals: runSession.usageTotals,
    providerRuntime: runSession.providerRuntime,
    contextUsage: runSession.contextUsage,
  });
  assert.equal(
    view.approvalPanel.pending?.callId,
    runSession.pendingApproval?.callId,
  );
  assert.equal(view.approvalPanel.permissionMode, 'basic');
  assert.equal(view.assistant.composerControls.modelId, 'grok-4.5');
  if (
    view.assistant.runState.contextUsage === null ||
    view.assistant.runState.contextUsage.quality === 'unknown'
  ) {
    assert.fail('expected known context usage');
  }
  assert.equal(view.assistant.runState.contextUsage.inputTokens, 212_500);
  assert.equal(view.assistant.runState.streamErrorCode, 'internal');
  assert.equal(
    view.assistant.runState.providerRuntime?.phase,
    'rate_limit_waiting',
  );
  assert.equal(
    view.assistant.runActions.onPrepareProviderTransition,
    runSession.prepareProviderTransition,
  );
  assert.equal(view.assistant.steering.pendingSteerFlushRequested, true);
  assert.equal(typeof view.assistant.steering.onFlushSteers, 'function');
  assert.equal(
    view.assistant.runActions.onBranchFromMessage,
    branchFromMessage,
  );
  assert.equal(
    view.assistant.runActions.onEditPastUserPrompt,
    editPastUserPrompt,
  );
  assert.equal(
    view.assistant.conversation.branchNotice,
    '⑂ 새 채팅으로 전환했습니다',
  );
  assert.equal(
    view.assistant.conversation.onDismissBranchNotice,
    dismissBranchNotice,
  );
  assert.deepEqual(Object.keys(view.assistant).sort(), [
    'activity',
    'artifacts',
    'composerControls',
    'composerSurface',
    'conversation',
    'runActions',
    'runState',
    'steering',
    'workflow',
  ]);
  assert.equal(view.approvalPanel.onApprove, runSession.handleApprove);
});
