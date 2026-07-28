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

function installMemoryLocalStorage(): {
  readonly values: Map<string, string>;
  restore(): void;
} {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  return {
    values,
    restore() {
      if (previous) {
        Object.defineProperty(globalThis, 'localStorage', previous);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    },
  };
}

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

void test('useRunSession carries last-used model choices but not cwd or approval into a new chat session', async () => {
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
  assert.equal(hook.result.current.permissionMode, 'basic');
  assert.equal(hook.result.current.workingDirectory, null);
  assert.equal(hook.result.current.modelId, 'grok-4.5');
  assert.equal(hook.result.current.reasoningEffort, 'high');
  assert.equal(hook.result.current.streamError, null);
  hook.unmount();
});

void test('useRunSession restores validated model and plan choices without leaking cwd after a shell reload', async () => {
  const storage = installMemoryLocalStorage();
  try {
    const firstHarness = createRunSessionClientHarness();
    const first = await renderHook(
      useRunSession,
      createRunSessionArgs({ createClient: firstHarness.createClient }),
    );

    await first.run(async (current) => {
      current.setWorkingDirectory('home/user/projects/kept-after-reload');
      await current.setPermissionMode('full_access');
      current.setModelId('qwen3.8-max-preview');
      current.setReasoningEffort('medium');
      current.setPlanModeRequested(true);
      current.setPlanModeDepth('deep');
      current.setPlanModeIntensity('quiet');
    });
    first.unmount();

    const secondHarness = createRunSessionClientHarness();
    const second = await renderHook(
      useRunSession,
      createRunSessionArgs({ createClient: secondHarness.createClient }),
    );

    assert.equal(second.result.current.workingDirectory, null);
    assert.equal(second.result.current.permissionMode, 'basic');
    assert.equal(second.result.current.modelId, 'qwen3.8-max-preview');
    assert.equal(second.result.current.reasoningEffort, 'medium');
    assert.equal(second.result.current.planModeRequested, true);
    assert.equal(second.result.current.planModeDepth, 'deep');
    assert.equal(second.result.current.planModeIntensity, 'quiet');
    assert.equal(storage.values.size, 1);
    const stored = JSON.parse(
      storage.values.get('geulbat.shell.run-session-preferences.v1') ?? '{}',
    ) as { preferences?: Record<string, unknown> };
    assert.equal(
      Object.hasOwn(stored.preferences ?? {}, 'workingDirectory'),
      false,
    );
    second.unmount();
  } finally {
    storage.restore();
  }
});

void test('useRunSession ignores an invalid stored run preference record', async () => {
  const storage = installMemoryLocalStorage();
  storage.values.set(
    'geulbat.shell.run-session-preferences.v1',
    JSON.stringify({
      version: 1,
      preferences: {
        workingDirectory: 'home/user/projects/untrusted',
        planModeRequested: true,
        planModeIntensity: 'decorative',
        planModeDepth: 'deep',
        modelId: 'removed-model',
        reasoningEffort: 'high',
        serviceTier: 'standard',
        subagentModelRouting: { mode: 'auto' },
      },
    }),
  );
  try {
    const harness = createRunSessionClientHarness();
    const hook = await renderHook(
      useRunSession,
      createRunSessionArgs({ createClient: harness.createClient }),
    );

    assert.equal(hook.result.current.workingDirectory, null);
    assert.equal(hook.result.current.planModeRequested, false);
    assert.equal(hook.result.current.planModeIntensity, 'visual');
    assert.equal(hook.result.current.modelId, 'gpt-5.6-sol');
    hook.unmount();
  } finally {
    storage.restore();
  }
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
