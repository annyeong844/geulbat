import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook } from '../test-support/hook-test.js';
import {
  createRunSessionArgs,
  createRunSessionClientHarness,
} from '../test-support/run-session-hook-harness.js';
import {
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';
import { useRunSession } from './use-run-session.js';

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
  const harness = createRunSessionClientHarness({
    async start() {
      return 'req-start-new-thread';
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      createClient: harness.createClient,
    }),
  );

  await hook.run(async (current) => {
    await current.sendPrompt('start a new thread');
  });
  await hook.flush();
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

void test('useRunSession synchronizes before sending and steers a run restored during reconnect', async () => {
  const steered: Array<{ runId: string; text: string }> = [];
  let startCalls = 0;
  const harness = createRunSessionClientHarness({
    async start() {
      startCalls += 1;
      return 'unexpected-start';
    },
    getActiveRunForThread(threadId) {
      return threadId === THREAD_ID_VALUE
        ? { runId: RUN_ID, threadId: THREAD_ID }
        : null;
    },
    async interject(request) {
      steered.push(request);
      return { requestId: 'req-reconnected-steer', receivedSeq: 3 };
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
    await current.sendPrompt('continue the recovered work');
  });
  await hook.flush();

  assert.equal(startCalls, 0);
  assert.deepEqual(steered, [
    { runId: RUN_ID, text: 'continue the recovered work' },
  ]);
  assert.equal(hook.result.current.activeRunId, RUN_ID);
  assert.equal(hook.result.current.isRunning, true);
  assert.deepEqual(hook.result.current.pendingSteers, [
    { receivedSeq: 3, text: 'continue the recovered work' },
  ]);
  hook.unmount();
});

void test('useRunSession refuses a new-turn-only prompt when reconnect restores an active run', async () => {
  let startCalls = 0;
  let interjectCalls = 0;
  const harness = createRunSessionClientHarness({
    async start() {
      startCalls += 1;
      return 'unexpected-start';
    },
    getActiveRunForThread(threadId) {
      return threadId === THREAD_ID_VALUE
        ? { runId: RUN_ID, threadId: THREAD_ID }
        : null;
    },
    async interject() {
      interjectCalls += 1;
      return { requestId: 'unexpected-interject', receivedSeq: 1 };
    },
  });
  const hook = await renderHook(
    useRunSession,
    createRunSessionArgs({
      selectedThreadId: THREAD_ID_VALUE,
      createClient: harness.createClient,
    }),
  );

  await assert.rejects(
    hook.run(async (current) => {
      await current.sendPromptAsNewTurn('answer after ask_user');
    }),
    /synchronized run is still active/,
  );
  await hook.flush();

  assert.equal(startCalls, 0);
  assert.equal(interjectCalls, 0);
  assert.equal(hook.result.current.activeRunId, RUN_ID);
  assert.equal(hook.result.current.isRunning, true);
  assert.deepEqual(hook.result.current.pendingSteers, []);
  hook.unmount();
});
