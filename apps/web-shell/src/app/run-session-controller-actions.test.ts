import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { brandProjectId, brandThreadId } from '../lib/id-brand-helpers.js';
import {
  sendPromptAction,
  startRunAction,
} from './run-session-controller-actions.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

type SendPromptActionArgs = Parameters<typeof sendPromptAction>[0];

const PROJECT_ID = 'project-1';
const BRANDED_PROJECT_ID = brandProjectId(PROJECT_ID);
const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

function createStartActionHarness() {
  const dispatched: RunSessionStateAction[] = [];
  const optimisticPrompts: string[] = [];
  const logFailures: Array<{ logContext: string; message: string }> = [];
  let clearCalls = 0;
  const startedRequests: RunRequest[] = [];

  return {
    dispatched,
    optimisticPrompts,
    logFailures,
    startedRequests,
    clearCalls: () => clearCalls,
    client: {
      async start(request: RunRequest) {
        startedRequests.push(request);
        return 'started';
      },
    },
    dispatch(action: RunSessionStateAction) {
      dispatched.push(action);
    },
    clearSessionError() {
      clearCalls += 1;
    },
    appendOptimisticUserMessage(prompt: string) {
      optimisticPrompts.push(prompt);
    },
    logCommandFailure(logContext: string, message: string) {
      logFailures.push({ logContext, message });
    },
  };
}

void test('sendPromptAction runs the shared run-start pipeline for prompt requests', async () => {
  const harness = createStartActionHarness();
  const promptInputs: SendPromptActionArgs['promptInputs'] = {
    selectedThreadId: THREAD_ID_VALUE,
    selectedFile: 'notes/today.md',
    permissionMode: 'basic',
  };

  await sendPromptAction({
    client: harness.client,
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    projectId: PROJECT_ID,
    prompt: 'Write the summary',
    promptInputs,
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    logCommandFailure: harness.logCommandFailure,
  });

  assert.equal(harness.clearCalls(), 1);
  assert.deepEqual(harness.optimisticPrompts, ['Write the summary']);
  assert.deepEqual(harness.dispatched, [
    { type: 'run_start_requested', threadId: THREAD_ID_VALUE },
  ]);
  assert.deepEqual(harness.startedRequests, [
    {
      prompt: 'Write the summary',
      projectId: BRANDED_PROJECT_ID,
      threadId: THREAD_ID,
      currentFile: 'notes/today.md',
      permissionMode: 'basic',
    },
  ]);
  assert.deepEqual(harness.logFailures, []);
});

void test('startRunAction reuses the shared run-start pipeline and surfaces failures consistently', async () => {
  const harness = createStartActionHarness();
  harness.client.start = async (request: RunRequest) => {
    harness.startedRequests.push(request);
    throw new Error('transport offline');
  };

  await startRunAction({
    client: harness.client,
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    request: {
      prompt: 'hidden prompt',
      displayPrompt: 'visible prompt',
      projectId: BRANDED_PROJECT_ID,
      threadId: THREAD_ID,
    },
    permissionMode: 'full_access',
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    optimisticPrompt: 'fallback prompt',
    logCommandFailure: harness.logCommandFailure,
  });

  assert.equal(harness.clearCalls(), 1);
  assert.deepEqual(harness.optimisticPrompts, ['visible prompt']);
  assert.deepEqual(harness.dispatched, [
    { type: 'run_start_requested', threadId: THREAD_ID_VALUE },
    { type: 'run_start_failed', message: '[internal] transport offline' },
  ]);
  assert.deepEqual(harness.startedRequests, [
    {
      prompt: 'hidden prompt',
      displayPrompt: 'visible prompt',
      projectId: BRANDED_PROJECT_ID,
      threadId: THREAD_ID,
      permissionMode: 'full_access',
    },
  ]);
  assert.deepEqual(harness.logFailures, [
    { logContext: 'stream error', message: 'transport offline' },
  ]);
});
