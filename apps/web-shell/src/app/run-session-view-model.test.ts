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
    workingDirectory: '/workspace',
    setWorkingDirectory: () => {
      seen.push('setWorkingDirectory');
    },
    state: {
      phase: 'running',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: RUN_ID,
        transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
        finalAnswerText: 'final',
        pendingApproval,
        providerRuntime: {
          phase: 'rate_limit_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
        },
        streamError: '[internal] failed',
        streamErrorCode: 'internal',
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
      contextUsageByThread: {
        [THREAD_ID_VALUE]: {
          state: 'measured',
          modelId: 'grok-4.5',
          inputTokens: 212_500,
          contextWindow: 500_000,
          thresholdTokens: 425_000,
        },
      },
    },
    permissionMode: 'full_access',
    modelId: 'grok-4.5',
    reasoningEffort: 'ultra',
    serviceTier: 'standard',
    subagentModelRouting: {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
    setPermissionMode: async () => {
      seen.push('setPermissionMode');
    },
    planModeRequested: false,
    setPlanModeRequested: () => {},
    planModeIntensity: 'visual',
    setPlanModeIntensity: () => {},
    planModeDepth: 'standard',
    setPlanModeDepth: () => {},
    planningWorkflow: null,
    goal: null,
    followupSuggestion: null,
    dismissFollowupSuggestion: () => {},
    setModelId: () => {
      seen.push('setModelId');
    },
    prepareProviderTransition: async () => {
      seen.push('prepareProviderTransition');
    },
    setReasoningEffort: () => {},
    setServiceTier: () => {
      seen.push('setServiceTier');
    },
    setSubagentModelRouting: () => {
      seen.push('setSubagentModelRouting');
    },
    sendPrompt: async () => {
      seen.push('sendPrompt');
    },
    sendPromptAsNewTurn: async () => {
      seen.push('sendPromptAsNewTurn');
    },
    sendWidgetPrompt: async () => {
      seen.push('sendWidgetPrompt');
    },
    requestWidgetTool: async () => {
      seen.push('requestWidgetTool');
      return { ok: true, output: 'tool-ok' };
    },
    regeneratePrompt: async () => {
      seen.push('regeneratePrompt');
    },
    cancelSteer: async () => {
      seen.push('cancelSteer');
    },
    flushSteers: async () => {
      seen.push('flushSteers');
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
    stopChildRun: async () => {
      seen.push('stopChildRun');
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
  assert.equal(viewModel.modelId, 'grok-4.5');
  assert.equal(viewModel.serviceTier, 'standard');
  if (
    viewModel.contextUsage === null ||
    viewModel.contextUsage.quality === 'unknown'
  ) {
    assert.fail('expected known context usage');
  }
  assert.equal(viewModel.contextUsage.inputTokens, 212_500);
  assert.equal(viewModel.streamError, '[internal] failed');
  assert.equal(viewModel.streamErrorCode, 'internal');
  assert.equal(viewModel.providerRuntime?.phase, 'rate_limit_waiting');
  assert.deepEqual(viewModel.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'failed',
    },
  ]);

  await viewModel.setPermissionMode('basic');
  viewModel.setModelId('gpt-5.6-sol');
  viewModel.setServiceTier('fast');
  await viewModel.prepareProviderTransition({
    sourceModelId: 'grok-4.5',
    targetModelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  });
  await viewModel.sendPrompt('prompt');
  await viewModel.startRunRequest({
    prompt: 'prompt',
  });
  await viewModel.handleApprove(pendingApproval, 'session');
  await viewModel.handleDeny(pendingApproval);
  await viewModel.handleCancel();
  await viewModel.stopChildRun({
    parentRunId: 'run-parent',
    childRunId: 'run-child',
  });

  assert.deepEqual(seen, [
    'setPermissionMode',
    'setModelId',
    'setServiceTier',
    'prepareProviderTransition',
    'sendPrompt',
    'startRunRequest',
    'handleApprove',
    'handleDeny',
    'handleCancel',
    'stopChildRun',
  ]);
});
