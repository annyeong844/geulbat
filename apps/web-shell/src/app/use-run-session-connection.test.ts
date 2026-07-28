import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import { RUN_SESSION_STREAM_BATCH_WINDOW_MS } from './run-session-stream-batch.js';
import { useRunSessionConnection } from './use-run-session-connection.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import { createComputerTreeRefreshController } from './run-session-computer-tree-refresh.js';
import { renderHook } from '../test-support/hook-test.js';
import {
  CHILD_RUN_ID,
  RUN_ID,
  THREAD_ID,
  createPersistedThreadDetail,
} from '../test-support/run-session-fixtures.js';

type RunSessionConnectionClient = Parameters<
  typeof useRunSessionConnection
>[0]['client'];

void test('useRunSessionConnection subscribes before connect so auth-time replay is observed', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const order: string[] = [];
  let replayedRunCount = 0;
  const replayedRunEvent: RunChannelServerMessage = {
    type: 'run.event',
    event: {
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'run_ack',
      payload: { runId: RUN_ID, threadId: THREAD_ID },
    },
  };
  const fakeClient = {
    async connect() {
      order.push('connect');
      listener?.(replayedRunEvent);
    },
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe(callback: (message: RunChannelServerMessage) => void) {
      order.push('subscribe');
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
    loadTree: async () => {},
    handleRunStarted: async () => {
      replayedRunCount += 1;
    },
    handleRunSettledSuccess: async () => {},
    handleRunSettleSyncFailed: async () => {},
    handleRunSettledError: async () => {},
    reportSessionFailure: () => {},
  });

  await hook.flush();

  assert.deepEqual(order, ['subscribe', 'connect']);
  assert.equal(replayedRunCount, 1);

  hook.unmount();
});

void test('useRunSessionConnection connects on mount and retries immediately when the page returns to the foreground', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const pageDocument = new EventTarget();
  const pageWindow = new EventTarget();
  let visibilityState = 'hidden';
  Object.defineProperty(pageDocument, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: pageDocument,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: pageWindow,
  });

  let connectCount = 0;
  let closeCount = 0;
  let hook: { unmount(): void } | undefined;
  const fakeClient = {
    async connect() {
      connectCount += 1;
    },
    async acknowledgeEvent() {
      return 'req-event-ack';
    },
    subscribe() {
      return () => {};
    },
    close() {
      closeCount += 1;
    },
  } satisfies RunSessionConnectionClient;

  try {
    hook = await renderHook(useRunSessionConnection, {
      client: fakeClient,
      dispatch: () => {},
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

    assert.equal(connectCount, 1);
    pageDocument.dispatchEvent(new Event('visibilitychange'));
    assert.equal(connectCount, 1);

    visibilityState = 'visible';
    pageDocument.dispatchEvent(new Event('visibilitychange'));
    assert.equal(connectCount, 2);

    const cachedPageHide = new Event('pagehide');
    Object.defineProperty(cachedPageHide, 'persisted', { value: true });
    pageWindow.dispatchEvent(cachedPageHide);
    assert.equal(closeCount, 0);

    pageWindow.dispatchEvent(new Event('pageshow'));
    assert.equal(connectCount, 3);

    const terminalPageHide = new Event('pagehide');
    Object.defineProperty(terminalPageHide, 'persisted', { value: false });
    pageWindow.dispatchEvent(terminalPageHide);
    assert.equal(closeCount, 0);

    hook.unmount();
    hook = undefined;
    pageDocument.dispatchEvent(new Event('visibilitychange'));
    pageWindow.dispatchEvent(new Event('pageshow'));
    assert.equal(connectCount, 3);
    assert.equal(closeCount, 1);
  } finally {
    hook?.unmount();
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', previousDocument);
    }
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', previousWindow);
    }
  }
});

void test('useRunSessionConnection keeps a single subscription across rerenders and uses the latest callbacks', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let closeCount = 0;
  const seen: string[] = [];
  const fakeClient = {
    async connect() {},
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
    async connect() {},
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

void test('useRunSessionConnection batches consecutive stream and display updates in event order', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  let releaseRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    releaseRunStarted = resolve;
  });
  const actions: RunSessionStateAction[] = [];
  const fakeClient = {
    async connect() {},
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
    handleRunStarted: () => runStarted,
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
        seq: 2,
        ts: new Date().toISOString(),
        type: 'run_ack',
        payload: { runId: RUN_ID, threadId: THREAD_ID },
      },
    });
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
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 5,
        ts: new Date().toISOString(),
        type: 'tool_call',
        payload: {
          callId: 'call-1',
          step: 1,
          tool: 'read_file',
          args: { path: 'README.md' },
        },
      },
    });
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 6,
        ts: new Date().toISOString(),
        type: 'subagent_spawned',
        payload: {
          parentRunId: RUN_ID,
          childRunId: CHILD_RUN_ID,
          childThreadId: THREAD_ID,
          subagentType: 'worker',
        },
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

    releaseRunStarted();
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
    {
      type: 'transcript_activity_added',
      runId: RUN_ID,
      threadId: THREAD_ID,
      streamedToolCallId: 'call-1',
      entry: {
        kind: 'tool_activity',
        tool: 'read_file',
        state: 'running',
        callId: 'call-1',
      },
    },
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'subagent_activity',
        parentRunId: RUN_ID,
        childRunId: CHILD_RUN_ID,
        childThreadId: THREAD_ID,
        subagentType: 'worker',
        state: 'spawned',
      },
    },
  ]);

  hook.unmount();
});

void test('useRunSessionConnection flushes pending stream text before settle effects', async () => {
  let listener: ((message: RunChannelServerMessage) => void) | null = null;
  const seen: string[] = [];
  const fakeClient = {
    async connect() {},
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
      if (
        action.type === 'transcript_activity_added' &&
        action.entry.kind === 'tool_activity'
      ) {
        seen.push(`tool:${action.entry.tool}`);
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
        type: 'tool_call',
        payload: {
          callId: 'call-before-settle',
          step: 1,
          tool: 'read_file',
          args: { path: 'README.md' },
        },
      },
    });
    invokeListener({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 5,
        ts: new Date().toISOString(),
        type: 'thread_state_persisted',
        payload: createPersistedThreadDetail(),
      },
    });
  });
  await hook.flush();

  assert.deepEqual(seen, ['stream:batched', 'tool:read_file', 'settled']);

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
    async connect() {},
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
