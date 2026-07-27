import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunSubagentModelRouting } from '@geulbat/protocol/run-contract';

import { renderHook } from '../test-support/hook-test.js';
import {
  createPersistedThreadDetailWithOverrides as createPersistedThreadDetail,
  createRunSessionArgs,
  createRunSessionClientHarness,
} from '../test-support/run-session-hook-harness.js';
import {
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';
import { useRunSession } from './use-run-session.js';

void test('useRunSession settles with the latest selectedFile instead of a stale closure value', async () => {
  const openedFiles: string[] = [];
  const appliedThreadSnapshots: string[] = [];
  let loadedThreads = 0;
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedFile: 'draft-1.md',
      loadThreads: async () => {
        loadedThreads += 1;
      },
      openThreadForRunSettle: async () => null,
      applyThreadSnapshotForRunSettle: (thread) => {
        appliedThreadSnapshots.push(thread.threadId);
        return true;
      },
      openFile: async (path: string) => {
        openedFiles.push(path);
      },
      createClient: harness.createClient,
    }),
  );

  await hook.rerender(
    createRunSessionArgs({
      selectedFile: 'draft-2.md',
      loadThreads: async () => {
        loadedThreads += 1;
      },
      openThreadForRunSettle: async () => null,
      applyThreadSnapshotForRunSettle: (thread) => {
        appliedThreadSnapshots.push(thread.threadId);
        return true;
      },
      openFile: async (path: string) => {
        openedFiles.push(path);
      },
      createClient: harness.createClient,
    }),
  );

  await hook.run(async () => {
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    });
  });
  await hook.flush();

  assert.deepEqual(openedFiles, ['draft-2.md']);
  assert.deepEqual(appliedThreadSnapshots, [THREAD_ID_VALUE]);
  assert.equal(loadedThreads, 1);
  hook.unmount();
});

void test('useRunSession settles the run without applying a stale persisted snapshot', async () => {
  let loadedThreads = 0;
  let openedFiles = 0;
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedFile: 'draft.md',
      selectedThreadId: THREAD_ID_VALUE,
      loadThreads: async () => {
        loadedThreads += 1;
      },
      applyThreadSnapshotForRunSettle: () => false,
      openFile: async () => {
        openedFiles += 1;
      },
      createClient: harness.createClient,
    }),
  );

  await hook.run(async () => {
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ack',
        payload: {
          runId: RUN_ID,
          threadId: THREAD_ID,
        },
      },
    });
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.isRunning, false);
  assert.equal(hook.result.current.isSettling, false);
  assert.equal(hook.result.current.activeRunId, null);
  assert.equal(loadedThreads, 2);
  assert.equal(openedFiles, 0);
  hook.unmount();
});

void test('useRunSession starts prompts through a stale callback with the latest explicit cwd selection', async () => {
  const startedRequests: Array<{
    promptRef: string;
    workingDirectory?: string;
    permissionMode?: string;
    modelId?: string;
    currentFile?: string;
    threadId?: string;
    serviceTier?: string;
    subagentModelRouting?: RunSubagentModelRouting;
  }> = [];
  const optimisticPrompts: string[] = [];
  const harness = createRunSessionClientHarness({
    start: async (request) => {
      assert.equal('prompt' in request, false);
      assert.equal('promptRef' in request, true);
      if (!('promptRef' in request)) {
        throw new Error('expected prepared prompt ref request');
      }
      startedRequests.push({
        promptRef: request.promptRef,
        ...(request.workingDirectory !== undefined
          ? { workingDirectory: request.workingDirectory }
          : {}),
        ...(request.permissionMode !== undefined
          ? { permissionMode: request.permissionMode }
          : {}),
        ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
        ...(request.currentFile !== undefined
          ? { currentFile: request.currentFile }
          : {}),
        ...(request.threadId !== undefined
          ? { threadId: request.threadId }
          : {}),
        ...(request.serviceTier !== undefined
          ? { serviceTier: request.serviceTier }
          : {}),
        ...(request.subagentModelRouting !== undefined
          ? { subagentModelRouting: request.subagentModelRouting }
          : {}),
      });
      return RUN_ID;
    },
  });

  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedFile: 'chapter-1.md',
      appendOptimisticUserMessage: (prompt: string) => {
        optimisticPrompts.push(prompt);
      },
      createClient: harness.createClient,
    }),
  );

  const staleSendPrompt = hook.result.current.sendPrompt;
  await hook.run(async (current) => {
    current.setWorkingDirectory('home/user/novel-one');
    await current.setPermissionMode('full_access');
    current.setServiceTier('fast');
  });
  await hook.rerender(
    createRunSessionArgs({
      selectedFile: 'chapter-2.md',
      selectedThreadId: THREAD_ID_VALUE,
      activeModelId: 'gpt-5.6-sol',
      runPreferences: {
        workingDirectory: 'home/user/Downloads',
        serviceTier: 'fast',
        subagentModelRouting: { mode: 'auto' },
      },
      appendOptimisticUserMessage: (prompt: string) => {
        optimisticPrompts.push(prompt);
      },
      createClient: harness.createClient,
    }),
  );
  await hook.run(async () => {
    await staleSendPrompt('Write the next scene');
  });

  assert.deepEqual(startedRequests, [
    {
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
      workingDirectory: 'home/user/Downloads',
      modelId: 'gpt-5.6-sol',
      permissionMode: 'basic',
      threadId: THREAD_ID_VALUE,
      serviceTier: 'fast',
      subagentModelRouting: { mode: 'auto' },
    },
  ]);
  assert.deepEqual(optimisticPrompts, ['Write the next scene']);
  hook.unmount();
});
