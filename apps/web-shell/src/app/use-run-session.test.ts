import test from 'node:test';
import assert from 'node:assert/strict';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type {
  RunStartRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type {
  ThreadDetailResponse,
  ThreadMessage,
} from '@geulbat/protocol/threads';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { appendThreadNotification } from './run-session-entry-state.js';
import { storeContextUsageByThread } from './run-session-context-usage-cache.js';
import { selectVisibleRunState } from './run-session-state-selectors.js';
import {
  createEmptyActiveRunView,
  type BackgroundNotificationsByThread,
} from './run-session-state-types.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { settleRunEffects, useRunSession } from './use-run-session.js';
import { renderHook } from '../test-support/hook-test.js';
import type { RunSessionControllerClient } from './use-run-session.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const OTHER_THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000002';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);
type UseRunSessionArgs = Parameters<typeof useRunSession>[0];

interface RunSessionClientHarness {
  createClient: () => RunSessionControllerClient;
  emit: (message: RunChannelServerMessage) => void;
  createClientCalls: () => number;
  connectCalls: () => number;
  closeCalls: () => number;
  subscribeCount: () => number;
  unsubscribeCount: () => number;
}

function createPersistedThreadDetail(args?: {
  snapshotVersion?: string;
  messages?: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
}): ThreadDetailResponse {
  return {
    threadId: THREAD_ID,
    snapshotVersion: args?.snapshotVersion ?? '2026-04-16T00:00:00.000Z',
    messages: args?.messages ?? [],
    artifacts: args?.artifacts ?? [],
  };
}

function createRunSessionArgs(
  overrides: Partial<UseRunSessionArgs> = {},
): UseRunSessionArgs {
  return {
    workingDirectory: '',
    selectedFile: null,
    selectedThreadId: null,
    loadThreads: async () => {},
    loadTree: async () => {},
    openThreadForRunSettle: async () => null,
    openFile: async () => {},
    appendOptimisticUserMessage: () => {},
    trimMessagesForRegenerate: () => {},
    setSelectedThreadId: () => {},
    prepareStartRequest: async (request) => ({
      ...(request.displayPrompt !== undefined
        ? { displayPrompt: request.displayPrompt }
        : {}),
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      ...(request.workingDirectory !== undefined
        ? { workingDirectory: request.workingDirectory }
        : {}),
      ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
      ...(request.currentFile !== undefined
        ? { currentFile: request.currentFile }
        : {}),
      ...(request.permissionMode !== undefined
        ? { permissionMode: request.permissionMode }
        : {}),
      ...(request.subagentModelRouting !== undefined
        ? { subagentModelRouting: request.subagentModelRouting }
        : {}),
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
    ...overrides,
  };
}

function createRunSessionClientHarness(overrides?: {
  start?: (request: RunStartRequest) => Promise<string>;
  approve?: (request: ApprovalRequest) => Promise<string>;
  cancel?: (request: CancelRequest) => Promise<string>;
  connect?: () => Promise<unknown>;
  close?: () => void;
}): RunSessionClientHarness {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  let createClientCalls = 0;
  let connectCalls = 0;
  let closeCalls = 0;
  let subscribeCount = 0;
  let unsubscribeCount = 0;

  const client: RunSessionControllerClient = {
    subscribe(callback) {
      subscribeCount += 1;
      listener = callback;
      return () => {
        unsubscribeCount += 1;
        if (listener === callback) {
          listener = null;
        }
      };
    },
    close() {
      closeCalls += 1;
      overrides?.close?.();
    },
    async interject() {
      return { requestId: 'req-interject', receivedSeq: 1 };
    },
    async cancelInterject() {
      return { cancelled: true };
    },
    async flushInterject() {
      return { flushed: true };
    },
    async tool() {
      return { ok: true, output: 'tool-ok' };
    },
    async start(request) {
      if (overrides?.start) {
        return await overrides.start(request);
      }
      throw new Error('start not implemented in client harness');
    },
    async approve(request) {
      if (overrides?.approve) {
        return await overrides.approve(request);
      }
      throw new Error('approve not implemented in client harness');
    },
    async cancel(request) {
      if (overrides?.cancel) {
        return await overrides.cancel(request);
      }
      throw new Error('cancel not implemented in client harness');
    },
    async connect() {
      connectCalls += 1;
      if (overrides?.connect) {
        return await overrides.connect();
      }
      return {};
    },
  };

  return {
    createClient() {
      createClientCalls += 1;
      return client;
    },
    emit(message) {
      if (listener === null) {
        throw new Error('run session listener was not registered');
      }
      listener(message);
    },
    createClientCalls: () => createClientCalls,
    connectCalls: () => connectCalls,
    closeCalls: () => closeCalls,
    subscribeCount: () => subscribeCount,
    unsubscribeCount: () => unsubscribeCount,
  };
}

void test('settleRunEffects continues running follow-up tasks even if one task rejects', async () => {
  const seen: string[] = [];

  const results = await settleRunEffects({
    threadId: THREAD_ID_VALUE,
    selectedFile: 'hello.txt',
    openThreadForRunSettle: async () => {
      seen.push('openThread');
      throw new Error('openThread failed');
    },
    loadThreads: async () => {
      seen.push('loadThreads');
    },
    openFile: async () => {
      seen.push('openFile');
    },
  });

  assert.deepEqual(
    seen.sort(),
    ['loadThreads', 'openFile', 'openThread'].sort(),
  );
  assert.equal(results.length, 3);
  assert.equal(results[0]?.status, 'rejected');
  assert.equal(
    results.slice(1).every((result) => result.status === 'fulfilled'),
    true,
  );
});

void test('useRunSession does not eagerly connect the run channel on mount', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
    }),
  );

  assert.equal(harness.createClientCalls(), 1);
  assert.equal(harness.connectCalls(), 0);
  hook.unmount();
});

void test('useRunSession restores the last exact context measurement on mount', async () => {
  const contextUsage = {
    state: 'measured',
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
  } as const;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  storeContextUsageByThread({ [THREAD_ID_VALUE]: contextUsage }, storage);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  });

  try {
    const hook = await renderHook(
      useRunSession,
      createRunSessionArgs({ selectedThreadId: THREAD_ID_VALUE }),
    );

    assert.deepEqual(hook.result.current.contextUsage, contextUsage);
    hook.unmount();
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

void test('useRunSession prepares a cross-provider thread without committing the model selection', async () => {
  const requests: unknown[] = [];
  let loadedThreads = 0;
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      loadThreads: async () => {
        loadedThreads += 1;
      },
      prepareProviderTransitionRequest: async (threadId, request) => {
        requests.push({ threadId, request });
        return {
          ok: true,
          status: 'compacted',
          threadId: THREAD_ID,
          sourceModelId: request.sourceModelId,
          targetModelId: request.targetModelId,
          compactionEntryId: 'entry-transition',
        };
      },
    }),
  );

  await hook.run((session) => session.setModelId('grok-4.5'));
  assert.equal(hook.result.current.modelId, 'grok-4.5');
  await hook.run((session) => session.prepareProviderTransition('gpt-5.6-sol'));

  assert.deepEqual(requests, [
    {
      threadId: THREAD_ID_VALUE,
      request: {
        sourceModelId: 'grok-4.5',
        targetModelId: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
      },
    },
  ]);
  assert.equal(loadedThreads, 1);
  assert.equal(hook.result.current.modelId, 'grok-4.5');
  hook.unmount();
});

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

void test('useRunSession ignores stale persisted snapshots without settling the active run', async () => {
  let loadedThreads = 0;
  let openedFiles = 0;
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedFile: 'draft.md',
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

  assert.equal(hook.result.current.isRunning, true);
  assert.equal(hook.result.current.isSettling, false);
  assert.equal(loadedThreads, 1);
  assert.equal(openedFiles, 0);
  hook.unmount();
});

void test('useRunSession starts prompts through a stale callback with the latest explorer directory', async () => {
  const startedRequests: Array<{
    promptRef: string;
    workingDirectory?: string;
    permissionMode?: string;
    modelId?: string;
    currentFile?: string;
    threadId?: string;
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
      workingDirectory: 'Users/sample/novel-one',
      selectedFile: 'chapter-1.md',
      appendOptimisticUserMessage: (prompt: string) => {
        optimisticPrompts.push(prompt);
      },
      createClient: harness.createClient,
    }),
  );

  const staleSendPrompt = hook.result.current.sendPrompt;
  await hook.run(async (current) => {
    current.setPermissionMode('full_access');
  });
  await hook.rerender(
    createRunSessionArgs({
      workingDirectory: 'Users/sample/Downloads',
      selectedFile: 'chapter-2.md',
      selectedThreadId: THREAD_ID_VALUE,
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
      workingDirectory: 'Users/sample/Downloads',
      modelId: 'gpt-5.6-sol',
      permissionMode: 'full_access',
      threadId: THREAD_ID_VALUE,
      subagentModelRouting: { mode: 'auto' },
    },
  ]);
  assert.deepEqual(optimisticPrompts, ['Write the next scene']);
  hook.unmount();
});

void test('useRunSession sends only one run.start while the first start is in flight or awaiting ack', async () => {
  let startCallCount = 0;
  let resolveStart!: (runId: string) => void;
  const startPromise = new Promise<string>((resolve) => {
    resolveStart = resolve;
  });
  const optimisticPrompts: string[] = [];
  const harness = createRunSessionClientHarness({
    start: async () => {
      startCallCount += 1;
      return await startPromise;
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      appendOptimisticUserMessage: (prompt) => {
        optimisticPrompts.push(prompt);
      },
      createClient: harness.createClient,
    }),
  );
  let firstStart!: Promise<void>;
  let sameTickDuplicate!: Promise<void>;

  await hook.run((current) => {
    firstStart = current.sendPrompt('first prompt');
    sameTickDuplicate = current.sendPrompt('same-tick duplicate');
  });
  await sameTickDuplicate;
  await hook.flush();

  assert.equal(startCallCount, 1);
  assert.deepEqual(optimisticPrompts, ['first prompt']);

  await hook.run(async () => {
    resolveStart(RUN_ID);
    await firstStart;
  });
  await hook.flush();
  assert.equal(hook.result.current.isRunStarting, true);

  await hook.run(async (current) => {
    await current.sendPrompt('duplicate before run ack');
  });

  assert.equal(startCallCount, 1);
  assert.deepEqual(optimisticPrompts, ['first prompt']);
  hook.unmount();
});

void test('useRunSession sends a fixed Luna xhigh subagent route independently from the root model', async () => {
  const seenRouting: RunSubagentModelRouting[] = [];
  const harness = createRunSessionClientHarness({
    start: async (request) => {
      if (request.subagentModelRouting !== undefined) {
        seenRouting.push(request.subagentModelRouting);
      }
      return RUN_ID;
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({ createClient: harness.createClient }),
  );

  await hook.run(async (current) => {
    current.setSubagentModelRouting({
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    });
  });
  await hook.run(async (current) => {
    await current.sendPrompt('Delegate this task');
  });

  assert.deepEqual(seenRouting, [
    {
      mode: 'fixed',
      choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    },
  ]);
  hook.unmount();
});

void test('useRunSession routes approval decisions through the controller command handlers', async () => {
  const requests: Array<{
    approved: boolean;
    grantScope: string;
    callId: string;
  }> = [];
  const harness = createRunSessionClientHarness({
    approve: async (request) => {
      requests.push({
        approved: request.approved,
        grantScope: request.grantScope,
        callId: request.callId,
      });
      return RUN_ID;
    },
  });

  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
    }),
  );
  const pendingApproval = makeApprovalRequiredFixture({
    runId: RUN_ID,
    threadId: THREAD_ID,
  });

  await hook.run(async (current) => {
    await current.handleApprove(pendingApproval, 'session');
    await current.handleDeny(pendingApproval);
  });

  assert.deepEqual(requests, [
    {
      approved: true,
      grantScope: 'session',
      callId: 'call-1',
    },
    {
      approved: false,
      grantScope: 'once',
      callId: 'call-1',
    },
  ]);
  hook.unmount();
});

void test('useRunSession reveals queued approvals with matching callId after the current approval is resolved', async () => {
  const requests: Array<{
    approved: boolean;
    grantScope: string;
    callId: string;
    runId: string;
    threadId: string;
  }> = [];
  const harness = createRunSessionClientHarness({
    approve: async (request) => {
      requests.push({
        approved: request.approved,
        grantScope: request.grantScope,
        callId: request.callId,
        runId: request.runId,
        threadId: request.threadId,
      });
      return RUN_ID;
    },
  });

  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
    }),
  );
  const firstApproval = makeApprovalRequiredFixture({
    callId: 'shared-call',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const secondApprovalRunId = brandRunId('run-child-1');
  const secondApproval = makeApprovalRequiredFixture({
    callId: 'shared-call',
    runId: secondApprovalRunId,
    threadId: THREAD_ID,
  });

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
        type: 'approval_required',
        payload: firstApproval,
      },
    });
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'approval_required',
        payload: secondApproval,
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.pendingApproval, firstApproval);

  await hook.run(async (current) => {
    await current.handleApprove(firstApproval, 'once');
  });
  await hook.flush();

  assert.deepEqual(requests, [
    {
      approved: true,
      grantScope: 'once',
      callId: 'shared-call',
      runId: RUN_ID,
      threadId: THREAD_ID,
    },
  ]);
  assert.equal(hook.result.current.pendingApproval, secondApproval);
  hook.unmount();
});

void test('useRunSession cancels the active run through a stale callback once the run is acknowledged', async () => {
  const cancelledRunIds: string[] = [];
  const harness = createRunSessionClientHarness({
    cancel: async (request) => {
      cancelledRunIds.push(request.runId);
      return RUN_ID;
    },
  });

  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      createClient: harness.createClient,
    }),
  );
  const staleHandleCancel = hook.result.current.handleCancel;

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
  });
  await hook.run(async () => {
    await staleHandleCancel();
  });

  assert.deepEqual(cancelledRunIds, [RUN_ID]);
  hook.unmount();
});

void test('useRunSession keeps a reconnect failure visible while cancelling a new-thread pending start', async () => {
  const harness = createRunSessionClientHarness({
    start: async () => await new Promise<string>(() => {}),
    connect: async () => {
      throw new Error('socket down');
    },
  });

  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
    }),
  );

  await hook.run((current) => {
    void current.sendPrompt('Write the next scene');
  });
  await hook.flush();
  await hook.run(async (current) => {
    await current.handleCancel();
  });
  await hook.flush();

  assert.equal(hook.result.current.isRunStarting, false);
  assert.equal(hook.result.current.streamError, '[internal] socket down');
  hook.unmount();
});

void test('useRunSession keeps a new-thread run visible after ack before thread selection catches up', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
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
        type: 'commentary_delta',
        payload: {
          text: 'Thinking...',
        },
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.visibleThreadId, THREAD_ID_VALUE);
  assert.equal(hook.result.current.activeRunId, RUN_ID);
  assert.equal(hook.result.current.isRunning, true);
  assert.deepEqual(hook.result.current.transcriptEntries, [
    { kind: 'assistant_text', text: 'Thinking...' },
  ]);
  hook.unmount();
});

void test('useRunSession applies persisted thread snapshots immediately and runs follow-up effects in the background', async () => {
  let resolveLoadThreads!: () => void;
  const loadThreadsGate = new Promise<void>((resolve) => {
    resolveLoadThreads = resolve;
  });
  const appliedSnapshots: string[] = [];
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      loadThreads: async () => {
        await loadThreadsGate;
      },
      applyThreadSnapshotForRunSettle: (thread) => {
        appliedSnapshots.push(thread.threadId);
        return true;
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
        type: 'commentary_delta',
        payload: {
          text: 'Still visible',
        },
      },
    });
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail({
          messages: [
            {
              entryId: 'entry-still-visible',
              role: 'assistant',
              content: 'Still visible',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.isRunning, false);
  assert.equal(hook.result.current.isSettling, false);
  assert.equal(hook.result.current.activeRunId, null);
  assert.deepEqual(appliedSnapshots, [THREAD_ID_VALUE]);

  resolveLoadThreads();
  await hook.flush();
  hook.unmount();
});

void test('useRunSession keeps artifact-only output visible until run settle effects complete', async () => {
  const appliedSnapshots: string[] = [];
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      applyThreadSnapshotForRunSettle: (thread) => {
        appliedSnapshots.push(thread.threadId);
        return true;
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
        type: 'artifact_committed',
        payload: {
          artifactId: 'art_js_1',
          version: 1,
          parentVersion: null,
          baseVersion: null,
          renderer: 'js',
          payload: 'export default function mount() {}',
          digest: 'heart demo',
          contentHash: 'hash-js-1',
          createdAt: new Date().toISOString(),
          createdByRunId: 'run-1',
          previewValidation: { ok: true },
          title: null,
          persistenceEpoch: 1,
          sourceRef: null,
        },
      },
    });
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail({
          messages: [
            {
              entryId: 'entry-artifact-only',
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
              metadata: {
                phase: 'final_answer',
                artifactRefs: [{ artifactId: 'art_js_1', version: 1 }],
                activeArtifactRef: { artifactId: 'art_js_1', version: 1 },
              },
            },
          ],
          artifacts: [
            {
              artifactId: 'art_js_1',
              version: 1,
              parentVersion: null,
              baseVersion: null,
              renderer: 'js',
              payload: 'export default function mount() {}',
              digest: 'heart demo',
              contentHash: 'hash-js-1',
              createdAt: new Date().toISOString(),
              createdByRunId: 'run-1',
              previewValidation: { ok: true },
              title: null,
              persistenceEpoch: 1,
              sourceRef: null,
            },
          ],
        }),
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.isRunning, false);
  assert.equal(hook.result.current.isSettling, false);
  assert.equal(hook.result.current.activeArtifact, null);
  assert.deepEqual(appliedSnapshots, [THREAD_ID_VALUE]);
  hook.unmount();
});

void test('useRunSession preserves streamed output and reports a daemon-owned sync failure', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      openThreadForRunSettle: async () => ({
        threadId: THREAD_ID,
        snapshotVersion: '2026-04-16T00:00:00.000Z',
        messages: [],
        artifacts: [],
      }),
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
        type: 'final_answer_delta',
        payload: {
          text: 'settled answer',
        },
      },
    });
    harness.emit({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'thread_state_persist_failed',
        payload: {
          message:
            'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
        },
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.isRunning, false);
  assert.equal(hook.result.current.isSettling, false);
  assert.equal(hook.result.current.activeRunId, RUN_ID);
  assert.equal(hook.result.current.finalAnswerText, 'settled answer');
  assert.equal(
    hook.result.current.streamError,
    'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
  );
  hook.unmount();
});

void test('appendThreadNotification keeps subagent activity entries scoped per thread and capped to ten', () => {
  let notifications: BackgroundNotificationsByThread = {};
  for (let index = 0; index < 12; index += 1) {
    notifications = appendThreadNotification(notifications, THREAD_ID_VALUE, {
      kind: 'subagent_activity',
      childRunId: `run-child-${index}`,
      subagentType: 'worker',
      state: 'completed',
    });
  }
  notifications = appendThreadNotification(
    notifications,
    OTHER_THREAD_ID_VALUE,
    {
      kind: 'subagent_activity',
      childRunId: 'other-thread',
      subagentType: 'worker',
      state: 'completed',
    },
  );

  assert.deepEqual(notifications[THREAD_ID_VALUE], [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-2',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-3',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-4',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-5',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-6',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-7',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-8',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-9',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-10',
      subagentType: 'worker',
      state: 'completed',
    },
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-11',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
  assert.deepEqual(notifications[OTHER_THREAD_ID_VALUE], [
    {
      kind: 'subagent_activity',
      childRunId: 'other-thread',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
});

void test('appendThreadNotification dedupes terminal replay entries by deliveryId', () => {
  let notifications: BackgroundNotificationsByThread = {};

  notifications = appendThreadNotification(notifications, THREAD_ID_VALUE, {
    kind: 'subagent_activity',
    deliveryId: 'delivery-1',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'completed',
  });
  notifications = appendThreadNotification(notifications, THREAD_ID_VALUE, {
    kind: 'subagent_activity',
    deliveryId: 'delivery-1',
    childRunId: 'run-child-1',
    subagentType: 'worker',
    state: 'completed',
  });

  assert.equal(notifications[THREAD_ID_VALUE]?.length, 1);
});

void test('selectVisibleRunState only exposes active run state for the selected thread', () => {
  const state = selectVisibleRunState({
    selectedThreadId: OTHER_THREAD_ID_VALUE,
    state: {
      phase: 'starting',
      pendingStartThreadId: THREAD_ID_VALUE,
      activeRunView: {
        ...createEmptyActiveRunView(THREAD_ID_VALUE),
        runId: 'run-1',
        transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
        finalAnswerText: 'final',
        pendingApproval: makeApprovalRequiredFixture({
          runId: RUN_ID,
          threadId: THREAD_ID,
        }),
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
        [OTHER_THREAD_ID_VALUE]: [
          {
            kind: 'subagent_activity',
            childRunId: 'run-child-2',
            subagentType: 'explorer',
            state: 'completed',
          },
        ],
      },
      contextUsageByThread: {},
    },
  });

  assert.equal(state.isRunning, false);
  assert.equal(state.visibleThreadId, OTHER_THREAD_ID_VALUE);
  assert.equal(state.activeRunId, null);
  assert.deepEqual(state.transcriptEntries, []);
  assert.equal(state.finalAnswerText, '');
  assert.equal(state.streamError, null);
  assert.equal(state.pendingApproval, null);
  assert.deepEqual(state.backgroundNotifications, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-2',
      subagentType: 'explorer',
      state: 'completed',
    },
  ]);
});

void test('selectVisibleRunState keeps threadless transport errors visible for the new-thread composer', () => {
  const state = selectVisibleRunState({
    selectedThreadId: null,
    state: {
      phase: 'error',
      pendingStartThreadId: null,
      activeRunView: {
        ...createEmptyActiveRunView(null),
        streamError: '[internal] socket down',
      },
      sessionError: null,
      backgroundNotificationsByThread: {},
      contextUsageByThread: {},
    },
  });

  assert.equal(state.visibleThreadId, null);
  assert.equal(state.streamError, '[internal] socket down');
  assert.equal(state.isRunning, false);
});
