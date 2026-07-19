import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import {
  adaptRunSessionMessage,
  handleRunSessionMessage,
  shouldRefreshTreeAfterToolResult,
} from './run-session-message-effects.js';
import { RUN_SESSION_STREAM_BATCH_WINDOW_MS } from './run-session-stream-batch.js';
import { useRunSessionConnection } from './use-run-session-connection.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import { createComputerTreeRefreshController } from './run-session-computer-tree-refresh.js';
import { renderHook } from '../test-support/hook-test.js';

const RUN_ID = brandRunId('run-1');
const CHILD_RUN_ID = brandRunId('run-child-1');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

type RunSessionConnectionClient = Parameters<
  typeof useRunSessionConnection
>[0]['client'];

function createPersistedThreadDetail() {
  return {
    threadId: THREAD_ID,
    snapshotVersion: '2026-04-16T00:00:00.000Z',
    messages: [
      {
        entryId: 'entry-persisted',
        role: 'assistant' as const,
        content: 'persisted',
        timestamp: '2026-04-16T00:00:00.000Z',
      },
    ],
    artifacts: [],
  };
}

void test('handleRunSessionMessage acknowledges the run and refreshes threads', async () => {
  const actions: RunSessionStateAction[] = [];
  const startedRuns: Array<{ threadId: string; runId: string }> = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 0,
        ts: new Date().toISOString(),
        type: 'run_ack',
        payload: { runId: RUN_ID, threadId: THREAD_ID },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: (threadId, runId) => {
      startedRuns.push({ threadId, runId });
    },
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, []);
  assert.deepEqual(startedRuns, [{ threadId: THREAD_ID, runId: RUN_ID }]);
});

void test('adaptRunSessionMessage keeps transport failure structured before shell formatting', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.error',
      code: 'internal',
      message: 'socket broke',
      status: 500,
    }),
    {
      kind: 'run_transport_error',
      code: 'internal',
      message: 'socket broke',
    },
  );
});

void test('adaptRunSessionMessage preserves a failed done event as terminal run evidence', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'done',
        payload: {
          answer: 'partial answer',
          ok: false,
        },
      },
    }),
    {
      kind: 'run_terminal',
      runId: RUN_ID,
      threadId: THREAD_ID,
      ok: false,
    },
  );
});

void test('handleRunSessionMessage dispatches failed done evidence to run state', async () => {
  const actions: RunSessionStateAction[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'done',
        payload: {
          answer: 'partial answer',
          ok: false,
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, [
    {
      type: 'run_terminal',
      runId: RUN_ID,
      threadId: THREAD_ID,
      ok: false,
    },
  ]);
});

void test('adaptRunSessionMessage maps usage_updated events to usage effects', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'usage_updated',
        payload: {
          inputTokens: 9800,
          outputTokens: 252,
          cachedInputTokens: 4000,
        },
      },
    }),
    {
      kind: 'usage_updated',
      threadId: THREAD_ID,
      usage: { inputTokens: 9800, outputTokens: 252, cachedInputTokens: 4000 },
    },
  );
});

void test('adaptRunSessionMessage maps context usage snapshots without estimating them', () => {
  const contextUsage = {
    state: 'measured' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
  };

  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: '2026-07-17T00:00:00.000Z',
        type: 'context_usage_updated',
        payload: contextUsage,
      },
    }),
    {
      kind: 'context_usage_updated',
      threadId: THREAD_ID,
      contextUsage,
    },
  );
});

void test('adaptRunSessionMessage promotes applied interjects to steer_applied effects', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'interject_applied',
        payload: {
          runId: RUN_ID,
          count: 1,
          receivedSeqs: [1],
        },
      },
    }),
    {
      kind: 'steer_applied',
      threadId: THREAD_ID,
      receivedSeqs: [1],
    },
  );
});

void test('adaptRunSessionMessage maps semantic subagent lifecycle events to transcript entries', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: CHILD_RUN_ID,
        threadId: THREAD_ID,
        seq: 7,
        ts: new Date().toISOString(),
        type: 'subagent_terminal',
        payload: {
          deliveryId: 'delivery-1',
          parentRunId: RUN_ID,
          childRunId: CHILD_RUN_ID,
          subagentType: 'worker',
          terminalState: 'failed',
          ok: false,
          reason: 'child_error',
          result: 'sub-agent failed',
        },
      },
    }),
    {
      kind: 'subagent_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-1',
        childRunId: CHILD_RUN_ID,
        subagentType: 'worker',
        state: 'failed',
        reason: 'child_error',
        result: 'sub-agent failed',
      },
    },
  );
});

void test('handleRunSessionMessage marks tree refresh when daemon reports computer file changes', async () => {
  const actions: RunSessionStateAction[] = [];
  let requestedRefreshCount = 0;

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'tool_result',
        payload: {
          callId: 'call-1',
          step: 1,
          tool: 'write_file',
          ok: false,
          errorCode: 'internal',
          error: 'write failed',
          computerFilesMayHaveChanged: true,
          displayText: 'ok',
          raw: {},
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {
      requestedRefreshCount += 1;
    },
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.equal(requestedRefreshCount, 1);
  assert.deepEqual(actions, [
    {
      type: 'transcript_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'tool_activity',
        tool: 'write_file',
        state: 'failed',
      },
    },
  ]);
});

void test('handleRunSessionMessage dispatches committed artifacts into live run state', async () => {
  const actions: RunSessionStateAction[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'artifact_committed',
        payload: {
          artifactId: 'art_1',
          version: 1,
          parentVersion: null,
          baseVersion: null,
          renderer: 'markdown',
          payload: '# title',
          digest: '요약',
          contentHash: 'hash',
          createdAt: '2026-04-10T00:00:00.000Z',
          createdByRunId: RUN_ID,
          previewValidation: { ok: true },
          title: null,
          persistenceEpoch: 0,
          sourceRef: {
            kind: 'thread-file',
            workingDirectory: 'computer-root',
            threadId: THREAD_ID,
            runId: RUN_ID,
            filePath: 'episodes/ch01.md',
            messageTimestamp: '2026-04-10T00:00:00.000Z',
          },
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, [
    {
      type: 'artifact_activated',
      threadId: THREAD_ID,
      artifact: {
        artifactId: 'art_1',
        version: 1,
        parentVersion: null,
        baseVersion: null,
        renderer: 'markdown',
        payload: '# title',
        digest: '요약',
        contentHash: 'hash',
        createdAt: '2026-04-10T00:00:00.000Z',
        createdByRunId: RUN_ID,
        previewValidation: { ok: true },
        title: null,
        persistenceEpoch: 0,
        sourceRef: {
          kind: 'thread-file',
          workingDirectory: 'computer-root',
          threadId: THREAD_ID,
          runId: RUN_ID,
          filePath: 'episodes/ch01.md',
          messageTimestamp: '2026-04-10T00:00:00.000Z',
        },
      },
    },
  ]);
});

void test('useRunSessionConnection keeps a single subscription across rerenders and uses the latest callbacks', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let closeCount = 0;
  const seen: string[] = [];
  const fakeClient = {
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe(callback: (message: RunChannelServerMessage) => void) {
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
      closeCount += 1;
    },
  } satisfies RunSessionConnectionClient;

  const hook = await renderHook(useRunSessionConnection, {
    client: fakeClient,
    dispatch: () => {
      seen.push('initial:dispatch');
    },
    computerTreeRefreshControllerRef: {
      current: createComputerTreeRefreshController(),
    },
    loadTree: async () => {
      seen.push('initial:loadTree');
    },
    handleRunStarted: async () => {
      seen.push('initial:handleRunStarted');
    },
    handleRunSettledSuccess: async () => {
      seen.push('initial:handleRunSettledSuccess');
    },
    handleRunSettleSyncFailed: async () => {
      seen.push('initial:handleRunSettleSyncFailed');
    },
    handleRunSettledError: async () => {
      seen.push('initial:handleRunSettledError');
    },
    reportSessionFailure: () => {
      seen.push('initial:reportSessionFailure');
    },
  });

  await hook.rerender({
    client: fakeClient,
    dispatch: () => {
      seen.push('latest:dispatch');
    },
    computerTreeRefreshControllerRef: {
      current: createComputerTreeRefreshController(),
    },
    loadTree: async () => {
      seen.push('latest:loadTree');
    },
    handleRunStarted: async () => {
      seen.push('latest:handleRunStarted');
    },
    handleRunSettledSuccess: async () => {
      seen.push('latest:handleRunSettledSuccess');
    },
    handleRunSettleSyncFailed: async () => {
      seen.push('latest:handleRunSettleSyncFailed');
    },
    handleRunSettledError: async () => {
      seen.push('latest:handleRunSettledError');
    },
    reportSessionFailure: () => {
      seen.push('latest:reportSessionFailure');
    },
  });

  assert.equal(subscribeCount, 1);
  assert.equal(unsubscribeCount, 0);

  const capturedListener = listener;
  if (capturedListener === null) {
    throw new Error('run session listener was not registered');
  }
  const invokeListener: (message: RunChannelServerMessage) => void =
    capturedListener;

  await hook.run(async () => {
    await invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'run_ack',
        payload: { runId: RUN_ID, threadId: THREAD_ID },
      },
    });
  });
  await hook.flush();

  assert.deepEqual(seen, ['latest:handleRunStarted']);

  hook.unmount();
  assert.equal(unsubscribeCount, 1);
  assert.equal(closeCount, 1);
});

void test('useRunSessionConnection reports Computer tree refresh failures', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const refreshError = new Error('tree refresh broke');
  const reports: Array<{ logContext: string; error: unknown }> = [];
  const fakeClient = {
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe(callback: (message: RunChannelServerMessage) => void) {
      listener = callback;
      return () => {
        if (listener === callback) {
          listener = null;
        }
      };
    },
    close() {},
  } satisfies RunSessionConnectionClient;

  const hook = await renderHook(useRunSessionConnection, {
    client: fakeClient,
    dispatch: () => {},
    computerTreeRefreshControllerRef: {
      current: createComputerTreeRefreshController(),
    },
    loadTree: async () => {
      throw refreshError;
    },
    handleRunStarted: async () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    reportSessionFailure: (logContext, error) => {
      reports.push({ logContext, error });
    },
  });

  const invokeListener = (message: RunChannelServerMessage) => {
    if (listener === null) {
      throw new Error('run session listener was not registered');
    }
    listener(message);
  };

  await hook.run(async () => {
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'tool_result',
        payload: {
          callId: 'call-1',
          step: 1,
          tool: 'write_file',
          ok: true,
          computerFilesMayHaveChanged: true,
          displayText: 'wrote file',
          raw: {},
        },
      },
    });
  });
  await hook.flush();

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.logContext, 'computer tree refresh failed');
  assert.equal(reports[0]?.error, refreshError);

  hook.unmount();
});

void test('useRunSessionConnection batches consecutive streamed text updates before dispatching', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const actions: RunSessionStateAction[] = [];
  const fakeClient = {
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe(callback: (message: RunChannelServerMessage) => void) {
      listener = callback;
      return () => {
        if (listener === callback) {
          listener = null;
        }
      };
    },
    close() {},
  } satisfies RunSessionConnectionClient;

  const hook = await renderHook(useRunSessionConnection, {
    client: fakeClient,
    dispatch: (action) => {
      actions.push(action);
    },
    computerTreeRefreshControllerRef: {
      current: createComputerTreeRefreshController(),
    },
    loadTree: async () => {},
    handleRunStarted: async () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    reportSessionFailure: () => {},
  });

  const invokeListener = (message: RunChannelServerMessage) => {
    if (listener === null) {
      throw new Error('run session listener was not registered');
    }
    listener(message);
  };

  await hook.run(async () => {
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'commentary_delta',
        payload: { text: 'hello ' },
      },
    });
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'commentary_delta',
        payload: { text: 'world' },
      },
    });

    assert.deepEqual(actions, [
      {
        type: 'assistant_text_streamed',
        threadId: THREAD_ID,
        target: 'transcript',
        text: 'hello ',
      },
    ]);

    await new Promise((resolve) =>
      setTimeout(resolve, RUN_SESSION_STREAM_BATCH_WINDOW_MS + 10),
    );
  });
  await hook.flush();

  assert.deepEqual(actions, [
    {
      type: 'assistant_text_streamed',
      threadId: THREAD_ID,
      target: 'transcript',
      text: 'hello ',
    },
    {
      type: 'assistant_text_streamed',
      threadId: THREAD_ID,
      target: 'transcript',
      text: 'world',
    },
  ]);

  hook.unmount();
});

void test('useRunSessionConnection flushes pending stream text before settle effects', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const seen: string[] = [];
  const fakeClient = {
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe(callback: (message: RunChannelServerMessage) => void) {
      listener = callback;
      return () => {
        if (listener === callback) {
          listener = null;
        }
      };
    },
    close() {},
  } satisfies RunSessionConnectionClient;

  const hook = await renderHook(useRunSessionConnection, {
    client: fakeClient,
    dispatch: (action) => {
      if (action.type === 'assistant_text_streamed') {
        seen.push(`stream:${action.text}`);
      }
    },
    computerTreeRefreshControllerRef: {
      current: createComputerTreeRefreshController(),
    },
    loadTree: async () => {},
    handleRunStarted: async () => {},
    handleRunSettledSuccess: async () => {
      seen.push('settled');
    },
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    reportSessionFailure: () => {},
  });

  const invokeListener = (message: RunChannelServerMessage) => {
    if (listener === null) {
      throw new Error('run session listener was not registered');
    }
    listener(message);
  };

  await hook.run(async () => {
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'commentary_delta',
        payload: { text: 'batched' },
      },
    });
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    });
  });
  await hook.flush();

  assert.deepEqual(seen, ['stream:batched', 'settled']);

  hook.unmount();
});

void test('useRunSessionConnection sequences terminal replay after snapshot settlement and stops on snapshot failure', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const seen: string[] = [];
  const reports: Array<{ logContext: string; error: unknown }> = [];
  const acknowledgements: Array<{
    runId: string;
    threadId: string;
    seq: number;
  }> = [];
  let snapshotFailure: Error | undefined;
  let releaseFollowUp: (() => void) | undefined;
  const followUpGate = new Promise<void>((resolve) => {
    releaseFollowUp = resolve;
  });
  let resolveFailureReported: (() => void) | undefined;
  const failureReported = new Promise<void>((resolve) => {
    resolveFailureReported = resolve;
  });
  const fakeClient = {
    async acknowledgeEvent(request: {
      runId: typeof RUN_ID;
      threadId: typeof THREAD_ID;
      seq: number;
    }) {
      seen.push('acknowledged');
      acknowledgements.push(request);
      return 'req-event-ack';
    },
    subscribe(callback: (message: RunChannelServerMessage) => void) {
      listener = callback;
      return () => {
        if (listener === callback) {
          listener = null;
        }
      };
    },
    close() {},
  } satisfies RunSessionConnectionClient;

  const hook = await renderHook(useRunSessionConnection, {
    client: fakeClient,
    dispatch: (action) => {
      if (action.type === 'run_terminal') {
        seen.push('terminal-applied');
      }
    },
    computerTreeRefreshControllerRef: {
      current: createComputerTreeRefreshController(),
    },
    loadTree: async () => {},
    handleRunStarted: async () => {},
    handleRunSettledSuccess: async () => {
      seen.push('snapshot-applied');
      await followUpGate;
      if (snapshotFailure) {
        throw snapshotFailure;
      }
    },
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    reportSessionFailure: (logContext, error) => {
      reports.push({ logContext, error });
      resolveFailureReported?.();
    },
  });

  const invokeListener = (message: RunChannelServerMessage) => {
    if (listener === null) {
      throw new Error('run session listener was not registered');
    }
    listener(message);
  };

  await hook.run(async () => {
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    });
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 5,
        ts: new Date().toISOString(),
        type: 'done',
        payload: { answer: 'persisted', ok: true },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(seen, ['snapshot-applied']);
  assert.deepEqual(acknowledgements, []);

  assert.ok(releaseFollowUp);
  releaseFollowUp();
  await hook.flush();

  assert.deepEqual(seen, [
    'snapshot-applied',
    'terminal-applied',
    'acknowledged',
  ]);
  assert.deepEqual(acknowledgements, [
    { runId: RUN_ID, threadId: THREAD_ID, seq: 5 },
  ]);

  snapshotFailure = new Error('snapshot application failed');
  await hook.run(() => {
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 6,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    });
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 7,
        ts: new Date().toISOString(),
        type: 'done',
        payload: { answer: 'must remain replayable', ok: true },
      },
    });
  });
  await failureReported;
  await hook.flush();

  assert.deepEqual(seen, [
    'snapshot-applied',
    'terminal-applied',
    'acknowledged',
    'snapshot-applied',
  ]);
  assert.deepEqual(acknowledgements, [
    { runId: RUN_ID, threadId: THREAD_ID, seq: 5 },
  ]);
  assert.deepEqual(reports, [
    {
      logContext: 'run channel message failed',
      error: snapshotFailure,
    },
  ]);
  hook.unmount();
});

void test('handleRunSessionMessage dispatches semantic subagent activity entries', async () => {
  const actions: RunSessionStateAction[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: CHILD_RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'subagent_spawned',
        payload: {
          parentRunId: RUN_ID,
          childRunId: CHILD_RUN_ID,
          subagentType: 'worker',
          childThreadId: THREAD_ID,
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(actions, [
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'subagent_activity',
        childRunId: CHILD_RUN_ID,
        childThreadId: THREAD_ID,
        subagentType: 'worker',
        state: 'spawned',
      },
    },
  ]);
  assert.equal(
    shouldRefreshTreeAfterToolResult({
      computerFilesMayHaveChanged: true,
    }),
    true,
  );
  assert.equal(
    shouldRefreshTreeAfterToolResult({
      computerFilesMayHaveChanged: false,
    }),
    false,
  );
});

void test('handleRunSessionMessage settles successful runs through the provided success callback', async () => {
  const settledThreadIds: string[] = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async (thread) => {
      settledThreadIds.push(thread.threadId);
    },
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(settledThreadIds, [THREAD_ID]);
});

void test('handleRunSessionMessage routes thread snapshot sync failures through the dedicated failure callback', async () => {
  const syncFailures: Array<{ threadId: string; message: string }> = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'thread_state_persist_failed',
        payload: {
          message:
            'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
        },
      },
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async (threadId, message) => {
      syncFailures.push({ threadId, message });
    },
    handleRunSettledError: async () => {},
  });

  assert.deepEqual(syncFailures, [
    {
      threadId: THREAD_ID,
      message:
        'Run finished, but refreshing the saved thread state failed. The streamed result is still shown.',
    },
  ]);
});

void test('handleRunSessionMessage settles errored runs through the provided error callback', async () => {
  const settledErrors: Array<{ threadId: string; message: string }> = [];

  await handleRunSessionMessage({
    message: {
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'error',
        payload: {
          code: 'internal',
          message: 'broken',
        },
      },
    },
    dispatch: () => {},
    requestComputerTreeRefresh: () => {},
    handleRunStarted: () => {},
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async (threadId, message) => {
      settledErrors.push({ threadId, message });
    },
  });

  assert.deepEqual(settledErrors, [
    {
      threadId: THREAD_ID,
      message: '[internal] broken',
    },
  ]);
});
