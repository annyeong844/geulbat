import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RunStartRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { storeContextUsageByThread } from './run-session-context-usage-cache.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { useRunSession } from './use-run-session.js';
import { renderHook } from '../test-support/hook-test.js';
import {
  createPersistedThreadDetailWithOverrides as createPersistedThreadDetail,
  createRunSessionArgs,
  createRunSessionClientHarness,
} from '../test-support/run-session-hook-harness.js';

import {
  OTHER_THREAD_ID_VALUE,
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';

void test('useRunSession connects the run channel on mount for durable run recovery', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
    }),
  );

  assert.equal(harness.createClientCalls(), 1);
  assert.equal(harness.connectCalls(), 1);
  hook.unmount();
});

void test('useRunSession subscribes the selected thread for durable child-result replay', async () => {
  const harness = createRunSessionClientHarness();
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      createClient: harness.createClient,
    }),
  );

  assert.deepEqual(harness.threadSubscriptionCalls(), [THREAD_ID_VALUE]);
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
    value: {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  const harness = createRunSessionClientHarness();

  try {
    const hook = await renderHook(
      useRunSession,
      createRunSessionArgs({
        selectedThreadId: THREAD_ID_VALUE,
        createClient: harness.createClient,
      }),
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

void test('useRunSession prepares an explicit overflow handoff without granting compaction to the retry run', async () => {
  const transitionRequests: unknown[] = [];
  const runRequests: RunStartRequest[] = [];
  let loadedThreads = 0;
  const harness = createRunSessionClientHarness({
    start: async (request) => {
      runRequests.push(request);
      return RUN_ID;
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      createClient: harness.createClient,
      loadThreads: async () => {
        loadedThreads += 1;
      },
      prepareProviderTransitionRequest: async (threadId, request) => {
        transitionRequests.push({ threadId, request });
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

  await hook.run((session) => session.setModelId('gpt-5.6-sol'));
  await hook.run((session) => session.setModelId('gpt-5.6-luna'));
  await hook.run((session) =>
    session.prepareProviderTransition({
      sourceModelId: 'gpt-5.6-sol',
      targetModelId: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    }),
  );

  assert.deepEqual(transitionRequests, [
    {
      threadId: THREAD_ID_VALUE,
      request: {
        sourceModelId: 'gpt-5.6-sol',
        targetModelId: 'gpt-5.6-luna',
        reasoningEffort: 'medium',
      },
    },
  ]);
  assert.equal(loadedThreads, 1);

  await hook.run((session) => session.sendPrompt('continue on Luna'));
  assert.equal(runRequests.length, 1);
  assert.equal(runRequests[0]?.providerTransitionRecovery, undefined);

  hook.unmount();
});

void test('useRunSession rejects a stale provider handoff target before calling the daemon', async () => {
  let prepareCount = 0;
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      prepareProviderTransitionRequest: async () => {
        prepareCount += 1;
        throw new Error('daemon should not be called');
      },
    }),
  );

  await hook.run((session) => session.setModelId('grok-4.5'));
  await assert.rejects(
    hook.run((session) =>
      session.prepareProviderTransition({
        sourceModelId: 'grok-4.5',
        targetModelId: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
      }),
    ),
    /target no longer matches/u,
  );
  assert.equal(prepareCount, 0);
  hook.unmount();
});

void test('useRunSession omits planModeRequested while plan mode is off', async () => {
  const startedRequests: RunStartRequest[] = [];
  const harness = createRunSessionClientHarness({
    start: async (request) => {
      startedRequests.push(request);
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

  await hook.run(async (current) => {
    await current.sendPrompt('just do it');
  });

  assert.equal(startedRequests.length, 1);
  assert.equal(startedRequests[0]?.planModeRequested, undefined);
  hook.unmount();
});

void test('useRunSession sends planModeRequested once plan mode is on', async () => {
  const startedRequests: RunStartRequest[] = [];
  const harness = createRunSessionClientHarness({
    start: async (request) => {
      startedRequests.push(request);
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

  await hook.run(async (current) => {
    current.setPlanModeRequested(true);
  });
  assert.equal(hook.result.current.planModeRequested, true);

  await hook.run(async (current) => {
    await current.sendPrompt('plan this first');
  });

  assert.equal(startedRequests.length, 1);
  assert.equal(startedRequests[0]?.planModeRequested, true);
  assert.equal(startedRequests[0]?.planModeIntensity, 'visual');
  assert.equal(startedRequests[0]?.planModeDepth, 'standard');
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

void test('useRunSession sends Ultra as the single reasoning-strength selection', async () => {
  const seen: Array<{
    reasoningEffort: string | undefined;
    subagentModelRouting: RunSubagentModelRouting | undefined;
  }> = [];
  const harness = createRunSessionClientHarness({
    start: async (request) => {
      seen.push({
        reasoningEffort: request.reasoningEffort,
        subagentModelRouting: request.subagentModelRouting,
      });
      return RUN_ID;
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({ createClient: harness.createClient }),
  );

  await hook.run((current) => {
    current.setModelId('grok-4.5');
  });
  await hook.run((current) => {
    current.setSubagentModelRouting({
      mode: 'fixed',
      choice: {
        modelId: 'qwen3.8-max-preview',
        reasoningEffort: 'medium',
      },
    });
    current.setReasoningEffort('ultra');
  });
  await hook.run(async (current) => {
    await current.sendPrompt('Use Ultra');
  });

  assert.deepEqual(seen, [
    {
      reasoningEffort: 'ultra',
      subagentModelRouting: {
        mode: 'fixed',
        choice: {
          modelId: 'qwen3.8-max-preview',
          reasoningEffort: 'medium',
        },
      },
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
      selectedThreadId: THREAD_ID_VALUE,
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

void test('useRunSession starts and preserves another selected thread while the first run continues', async () => {
  const startedThreadIds: Array<string | undefined> = [];
  const secondRunId = brandRunId('run-2');
  const otherThreadId = brandThreadId(OTHER_THREAD_ID_VALUE);
  const harness = createRunSessionClientHarness({
    async start(request) {
      startedThreadIds.push(request.threadId);
      return 'req-start-second-thread';
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
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
  });
  await hook.rerender(
    createRunSessionArgs({
      selectedThreadId: OTHER_THREAD_ID_VALUE,
      createClient: harness.createClient,
    }),
  );

  await hook.run(async (current) => {
    await current.sendPrompt('start independent work in this thread');
  });
  await hook.flush();

  assert.deepEqual(startedThreadIds, [OTHER_THREAD_ID_VALUE]);
  assert.equal(hook.result.current.activeRunId, null);
  assert.equal(hook.result.current.isRunStarting, true);

  await hook.run(async () => {
    harness.emit({
      type: 'run.event',
      event: {
        runId: secondRunId,
        threadId: otherThreadId,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ack',
        payload: {
          runId: secondRunId,
          threadId: otherThreadId,
        },
      },
    });
    harness.emit({
      type: 'run.event',
      event: {
        runId: secondRunId,
        threadId: otherThreadId,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'commentary_delta',
        payload: { text: 'second thread working' },
      },
    });
  });
  await hook.flush();

  assert.equal(hook.result.current.activeRunId, secondRunId);
  assert.equal(hook.result.current.isRunning, true);
  assert.deepEqual(hook.result.current.transcriptEntries, [
    { kind: 'assistant_text', text: 'second thread working' },
  ]);

  await hook.rerender(
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      createClient: harness.createClient,
    }),
  );
  assert.equal(hook.result.current.activeRunId, RUN_ID);
  assert.equal(hook.result.current.isRunning, true);
  assert.deepEqual(hook.result.current.pendingSteers, []);
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
