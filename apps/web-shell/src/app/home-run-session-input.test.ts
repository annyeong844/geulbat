import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import type { RunSessionViewModel } from './run-session-view-model.js';
import { createHomeRunSessionInput } from './home-run-session-input.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

function createRunSessionViewModelStub(): RunSessionViewModel {
  return {
    visibleThreadId: THREAD_ID,
    activeRunId: RUN_ID,
    isRunStarting: true,
    isRunning: true,
    isSettling: true,
    transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
    finalAnswerText: 'done',
    streamingArtifactText: '',
    activeArtifact: null,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    permissionMode: 'full_access',
    modelId: 'grok-4.5',
    reasoningEffort: 'ultra',
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
    goal: null,
    followupSuggestion: null,
    dismissFollowupSuggestion: () => {},
    setModelId: () => {},
    prepareProviderTransition: async () => {},
    setReasoningEffort: () => {},
    setServiceTier: () => {},
    setSubagentModelRouting: () => {},
    requestWidgetTool: async () => ({ ok: true, output: 'tool-ok' }),
    streamError: 'stream failed',
    streamErrorCode: 'internal',
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    usageTotals: {
      inputTokens: 9800,
      outputTokens: 252,
      cachedInputTokens: 4000,
    },
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
  };
}

void test('createHomeRunSessionInput preserves the run-session surface used by Home shell', () => {
  const runSession = createRunSessionViewModelStub();
  const input = createHomeRunSessionInput(runSession);

  assert.equal(input.visibleThreadId, THREAD_ID);
  assert.equal(input.isRunStarting, true);
  assert.equal(input.isRunning, true);
  assert.equal(input.isRunSettling, true);
  assert.equal(input.transcriptEntries, runSession.transcriptEntries);
  assert.equal(input.finalAnswerText, 'done');
  assert.equal(input.activeArtifact, null);
  assert.equal(input.pendingApproval, runSession.pendingApproval);
  assert.equal(input.permissionMode, 'full_access');
  assert.equal(input.modelId, 'grok-4.5');
  assert.equal(input.serviceTier, 'standard');
  assert.deepEqual(input.subagentModelRouting, { mode: 'auto' });
  assert.equal(input.setPermissionMode, runSession.setPermissionMode);
  assert.equal(input.setModelId, runSession.setModelId);
  assert.equal(input.setServiceTier, runSession.setServiceTier);
  assert.equal(
    input.prepareProviderTransition,
    runSession.prepareProviderTransition,
  );
  assert.equal(
    input.setSubagentModelRouting,
    runSession.setSubagentModelRouting,
  );
  assert.equal(input.flushSteers, runSession.flushSteers);
  assert.equal(input.pendingSteerFlushRequested, true);
  assert.equal(input.streamError, 'stream failed');
  assert.equal(input.streamErrorCode, 'internal');
  assert.equal(input.usageTotals, runSession.usageTotals);
  assert.equal(input.providerRuntime, runSession.providerRuntime);
  assert.equal(input.contextUsage, runSession.contextUsage);
  assert.equal(
    input.backgroundNotifications,
    runSession.backgroundNotifications,
  );
  assert.equal(input.sendPrompt, runSession.sendPrompt);
  assert.equal(input.startRunRequest, runSession.startRunRequest);
  assert.equal(input.handleApprove, runSession.handleApprove);
  assert.equal(input.handleDeny, runSession.handleDeny);
  assert.equal(input.handleCancel, runSession.handleCancel);
});
