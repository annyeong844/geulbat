import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brandProjectId,
  brandRunId,
  brandThreadId,
} from '../lib/id-brand-helpers.js';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import {
  adaptRunSessionMessage,
  handleRunSessionMessage,
  shouldRefreshTreeAfterToolResult,
} from './run-session-message-effects.js';
import { RUN_SESSION_STREAM_BATCH_WINDOW_MS } from './run-session-stream-batch.js';
import { useRunSessionConnection } from './use-run-session-connection.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import {
  createProjectTreeRefreshController,
  requestProjectTreeRefresh,
} from './run-session-tree-refresh.js';
import { renderHook } from '../test-support/hook-test.js';

const RUN_ID = brandRunId('run-1');
const CHILD_RUN_ID = brandRunId('run-child-1');
const PROJECT_ID = brandProjectId('workspace');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

type RunSessionConnectionClient = Parameters<
  typeof useRunSessionConnection
>[0]['client'];

function createPersistedThreadDetail() {
  return {
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
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

void test('requestProjectTreeRefresh coalesces repeated requests while a refresh is in flight', async () => {
  const controller = createProjectTreeRefreshController();
  const resolvers: Array<() => void> = [];
  let loadCount = 0;

  const loadTree = () =>
    new Promise<void>((resolve) => {
      loadCount += 1;
      resolvers.push(resolve);
    });

  void requestProjectTreeRefresh(controller, loadTree);
  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'running');

  void requestProjectTreeRefresh(controller, loadTree);
  assert.equal(loadCount, 1);
  assert.equal(controller.readPhase(), 'queued');

  const firstResolve = resolvers.shift();
  assert.ok(firstResolve);
  firstResolve();
  await Promise.resolve();

  assert.equal(loadCount, 2);
  assert.equal(controller.readPhase(), 'running');

  const secondResolve = resolvers.shift();
  assert.ok(secondResolve);
  secondResolve();
  await Promise.resolve();

  assert.equal(loadCount, 2);
  assert.equal(controller.readPhase(), 'idle');
});

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
    requestProjectTreeRefresh: () => {},
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

void test('adaptRunSessionMessage ignores applied interject acknowledgement events', () => {
  assert.equal(
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
    null,
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

void test('handleRunSessionMessage marks tree refresh when daemon reports workspace file changes', async () => {
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
          workspaceFilesMayHaveChanged: true,
          displayText: 'ok',
          raw: {},
        },
      },
    },
    dispatch: (action) => {
      actions.push(action);
    },
    requestProjectTreeRefresh: () => {
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
            projectId: PROJECT_ID,
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
    requestProjectTreeRefresh: () => {},
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
          projectId: PROJECT_ID,
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
    projectTreeRefreshControllerRef: {
      current: createProjectTreeRefreshController(),
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
    projectTreeRefreshControllerRef: {
      current: createProjectTreeRefreshController(),
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

void test('useRunSessionConnection reports project tree refresh failures', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const refreshError = new Error('tree refresh broke');
  const reports: Array<{ logContext: string; error: unknown }> = [];
  const fakeClient = {
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
    projectTreeRefreshControllerRef: {
      current: createProjectTreeRefreshController(),
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
          workspaceFilesMayHaveChanged: true,
          displayText: 'wrote file',
          raw: {},
        },
      },
    });
  });
  await hook.flush();

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.logContext, 'project tree refresh failed');
  assert.equal(reports[0]?.error, refreshError);

  hook.unmount();
});

void test('useRunSessionConnection batches consecutive streamed text updates before dispatching', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const actions: RunSessionStateAction[] = [];
  const fakeClient = {
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
    projectTreeRefreshControllerRef: {
      current: createProjectTreeRefreshController(),
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
    projectTreeRefreshControllerRef: {
      current: createProjectTreeRefreshController(),
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
    requestProjectTreeRefresh: () => {},
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
        subagentType: 'worker',
        state: 'spawned',
      },
    },
  ]);
  assert.equal(
    shouldRefreshTreeAfterToolResult({
      workspaceFilesMayHaveChanged: true,
    }),
    true,
  );
  assert.equal(
    shouldRefreshTreeAfterToolResult({
      workspaceFilesMayHaveChanged: false,
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
    requestProjectTreeRefresh: () => {},
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
    requestProjectTreeRefresh: () => {},
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
    requestProjectTreeRefresh: () => {},
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
