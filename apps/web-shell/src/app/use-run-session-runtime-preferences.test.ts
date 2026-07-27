import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook } from '../test-support/hook-test.js';
import {
  createRunSessionArgs,
  createRunSessionClientHarness,
} from '../test-support/run-session-hook-harness.js';
import {
  OTHER_THREAD_ID_VALUE,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';
import { useRunSession } from './use-run-session.js';

void test('useRunSession restores saved runtime preferences for an existing chat session', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
      selectedThreadId: THREAD_ID_VALUE,
      activeModelId: 'grok-4.5',
      runPreferences: {
        workingDirectory: 'home/user/projects/thread-one',
        permissionMode: 'full_access',
        reasoningEffort: 'high',
        serviceTier: 'standard',
        subagentModelRouting: {
          mode: 'fixed',
          choice: {
            modelId: 'gpt-5.6-terra',
            reasoningEffort: 'medium',
          },
        },
      },
    }),
  );

  assert.equal(
    hook.result.current.workingDirectory,
    'home/user/projects/thread-one',
  );
  assert.equal(hook.result.current.permissionMode, 'full_access');
  assert.equal(hook.result.current.modelId, 'grok-4.5');
  assert.equal(hook.result.current.reasoningEffort, 'high');
  assert.equal(hook.result.current.serviceTier, 'standard');
  assert.deepEqual(hook.result.current.subagentModelRouting, {
    mode: 'fixed',
    choice: {
      modelId: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
    },
  });
  hook.unmount();
});

void test('useRunSession remembers approval and runtime choices separately for each mounted chat session', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
      selectedThreadId: THREAD_ID_VALUE,
      activeModelId: 'gpt-5.6-sol',
      runPreferences: {
        workingDirectory: 'home/user/projects/thread-one',
      },
    }),
  );

  await hook.run(async (current) => {
    current.setWorkingDirectory('home/user/projects/thread-one/chapters');
    await current.setPermissionMode('full_access');
    current.setModelId('grok-4.5');
    current.setReasoningEffort('high');
  });
  await hook.rerender(
    createRunSessionArgs({
      createClient: harness.createClient,
      selectedThreadId: OTHER_THREAD_ID_VALUE,
      activeModelId: 'gpt-5.6-terra',
      runPreferences: {
        workingDirectory: 'home/user/projects/thread-two',
      },
    }),
  );
  assert.equal(
    hook.result.current.workingDirectory,
    'home/user/projects/thread-two',
  );
  assert.equal(hook.result.current.permissionMode, 'basic');
  assert.equal(hook.result.current.modelId, 'gpt-5.6-terra');

  await hook.rerender(
    createRunSessionArgs({
      createClient: harness.createClient,
      selectedThreadId: THREAD_ID_VALUE,
      activeModelId: 'gpt-5.6-sol',
      runPreferences: {
        workingDirectory: 'home/user/projects/thread-one',
      },
    }),
  );
  assert.equal(
    hook.result.current.workingDirectory,
    'home/user/projects/thread-one/chapters',
  );
  assert.equal(hook.result.current.permissionMode, 'full_access');
  assert.equal(hook.result.current.modelId, 'grok-4.5');
  assert.equal(hook.result.current.reasoningEffort, 'high');
  hook.unmount();
});

void test('useRunSession resets runtime choices and a previous failure for a newly created chat session', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
      prepareStartRequest: async () => {
        throw new Error('run channel websocket connection failed');
      },
    }),
  );

  await hook.run(async (current) => {
    current.setWorkingDirectory('home/user/projects/old-session');
    await current.setPermissionMode('full_access');
    current.setModelId('grok-4.5');
    current.setReasoningEffort('high');
    await current.sendPrompt('old session request');
  });
  assert.match(
    hook.result.current.streamError ?? '',
    /run channel websocket connection failed/,
  );

  await hook.rerender(
    createRunSessionArgs({
      createClient: harness.createClient,
      newSessionGeneration: 1,
    }),
  );
  assert.equal(hook.result.current.workingDirectory, null);
  assert.equal(hook.result.current.permissionMode, 'basic');
  assert.equal(hook.result.current.modelId, 'gpt-5.6-sol');
  assert.equal(hook.result.current.reasoningEffort, 'medium');
  assert.equal(hook.result.current.streamError, null);
  hook.unmount();
});

void test('useRunSession resets Fast synchronously when the selected model does not support it', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({ createClient: harness.createClient }),
  );

  await hook.run(async (current) => {
    current.setServiceTier('fast');
  });
  assert.equal(hook.result.current.serviceTier, 'fast');

  await hook.run(async (current) => {
    current.setModelId('grok-4.5');
  });
  assert.equal(hook.result.current.serviceTier, 'standard');
  hook.unmount();
});
