import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';

import { brandThreadId } from '../lib/id-brand-helpers.js';
import {
  cancelSteerAction,
  flushSteersAction,
  degradeWidgetToolRequestAction,
  interjectPromptAction,
  regeneratePromptAction,
  sendPromptAction,
  startRunAction,
} from './run-session-controller-actions.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

type SendPromptActionArgs = Parameters<typeof sendPromptAction>[0];

const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

function createStartActionHarness() {
  const dispatched: RunSessionStateAction[] = [];
  const optimisticPrompts: string[] = [];
  const logFailures: Array<{ logContext: string; message: string }> = [];
  let clearCalls = 0;
  const startedRequests: RunStartRequest[] = [];

  return {
    dispatched,
    optimisticPrompts,
    logFailures,
    startedRequests,
    clearCalls: () => clearCalls,
    client: {
      async start(request: RunStartRequest) {
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
    workingDirectory: 'home/user/Downloads',
    modelId: 'grok-4.5',
    selectedThreadId: THREAD_ID_VALUE,
    permissionMode: 'basic',
    reasoningEffort: 'medium',
    subagentModelRouting: { mode: 'auto' },
  };

  await sendPromptAction({
    client: harness.client,
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    prompt: 'Write the summary',
    promptInputs,
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    logCommandFailure: harness.logCommandFailure,
    prepareStartRequest: async (request) => ({
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
  });

  assert.equal(harness.clearCalls(), 1);
  assert.deepEqual(harness.optimisticPrompts, ['Write the summary']);
  assert.deepEqual(harness.dispatched, [
    { type: 'run_start_requested', threadId: THREAD_ID_VALUE },
  ]);
  assert.deepEqual(harness.startedRequests, [
    {
      workingDirectory: 'home/user/Downloads',
      modelId: 'grok-4.5',
      threadId: THREAD_ID,
      permissionMode: 'basic',
      subagentModelRouting: { mode: 'auto' },
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    },
  ]);
  assert.deepEqual(harness.logFailures, []);
});

void test('regeneratePromptAction trims the stale turn and optimistically re-appends the (edited) prompt', async () => {
  const harness = createStartActionHarness();
  let trimCalls = 0;
  const promptInputs: SendPromptActionArgs['promptInputs'] = {
    workingDirectory: 'home/user/Documents',
    modelId: 'grok-4.5',
    selectedThreadId: THREAD_ID_VALUE,
    permissionMode: 'basic',
    reasoningEffort: 'medium',
    subagentModelRouting: { mode: 'auto' },
  };

  await regeneratePromptAction({
    client: harness.client,
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    prompt: 'Write the summary',
    promptInputs,
    trimMessagesForRegenerate: () => {
      trimCalls += 1;
    },
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    logCommandFailure: harness.logCommandFailure,
    prepareStartRequest: async (request) => ({
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      ...(request.workingDirectory !== undefined
        ? { workingDirectory: request.workingDirectory }
        : {}),
      ...(request.regenerate !== undefined
        ? { regenerate: request.regenerate }
        : {}),
      ...(request.subagentModelRouting !== undefined
        ? { subagentModelRouting: request.subagentModelRouting }
        : {}),
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
  });

  assert.equal(trimCalls, 1);
  // 트림이 옛 질문까지 걷어내므로, (수정된) 질문이 즉시 낙관적으로 다시 붙는다
  assert.deepEqual(harness.optimisticPrompts, ['Write the summary']);
  assert.equal(harness.startedRequests.length, 1);
  const started = harness.startedRequests[0];
  assert.ok(started && 'regenerate' in started && started.regenerate === true);
  assert.equal(started?.workingDirectory, 'home/user/Documents');
  assert.deepEqual(harness.logFailures, []);
});

void test('regeneratePromptAction is a no-op without a selected thread', async () => {
  const harness = createStartActionHarness();
  let trimCalls = 0;

  await regeneratePromptAction({
    client: harness.client,
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    prompt: 'Write the summary',
    promptInputs: {
      modelId: 'grok-4.5',
      selectedThreadId: null,
      permissionMode: 'basic',
      reasoningEffort: 'medium',
      subagentModelRouting: { mode: 'auto' },
    },
    trimMessagesForRegenerate: () => {
      trimCalls += 1;
    },
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    logCommandFailure: harness.logCommandFailure,
  });

  assert.equal(trimCalls, 0);
  assert.deepEqual(harness.startedRequests, []);
});

void test('startRunAction reuses the shared run-start pipeline and surfaces failures consistently', async () => {
  const harness = createStartActionHarness();
  harness.client.start = async (request: RunStartRequest) => {
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
      threadId: THREAD_ID,
    },
    modelId: 'gpt-5.6-sol',
    permissionMode: 'full_access',
    subagentModelRouting: { mode: 'auto' },
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    optimisticPrompt: 'fallback prompt',
    logCommandFailure: harness.logCommandFailure,
    prepareStartRequest: async (request) => ({
      ...(request.displayPrompt !== undefined
        ? { displayPrompt: request.displayPrompt }
        : {}),
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
      ...(request.permissionMode !== undefined
        ? { permissionMode: request.permissionMode }
        : {}),
      ...(request.subagentModelRouting !== undefined
        ? { subagentModelRouting: request.subagentModelRouting }
        : {}),
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    }),
  });

  assert.equal(harness.clearCalls(), 1);
  assert.deepEqual(harness.optimisticPrompts, ['visible prompt']);
  assert.deepEqual(harness.dispatched, [
    { type: 'run_start_requested', threadId: THREAD_ID_VALUE },
    { type: 'run_start_failed', message: '[internal] transport offline' },
  ]);
  assert.deepEqual(harness.startedRequests, [
    {
      displayPrompt: 'visible prompt',
      modelId: 'gpt-5.6-sol',
      threadId: THREAD_ID,
      permissionMode: 'full_access',
      subagentModelRouting: { mode: 'auto' },
      promptRef: 'run-prompt-input:11111111-1111-4111-8111-111111111111',
    },
  ]);
  assert.deepEqual(harness.logFailures, [
    { logContext: 'stream error', message: 'transport offline' },
  ]);
});

void test('interjectPromptAction queues the steer instead of appending a bubble', async () => {
  const dispatched: RunSessionStateAction[] = [];
  let clearCalls = 0;
  const seenRequests: unknown[] = [];

  await interjectPromptAction({
    client: {
      async interject(request) {
        seenRequests.push(request);
        assert.deepEqual(dispatched, []);
        return { requestId: 'req-1', receivedSeq: 3 };
      },
      async cancelInterject() {
        assert.fail('cancel should not run on the accept path');
      },
      async flushInterject() {
        assert.fail('flush should not run on the accept path');
      },
    },
    dispatch(action) {
      dispatched.push(action);
    },
    clearSessionError() {
      clearCalls += 1;
    },
    activeRunId: 'run-1',
    threadId: THREAD_ID_VALUE,
    prompt: 'please steer',
    logCommandFailure() {
      assert.fail('accept path should not log failure');
    },
  });

  assert.equal(clearCalls, 1);
  assert.deepEqual(dispatched, [
    {
      type: 'steer_queued',
      threadId: THREAD_ID_VALUE,
      steer: { receivedSeq: 3, text: 'please steer' },
    },
  ]);
  assert.deepEqual(seenRequests, [{ runId: 'run-1', text: 'please steer' }]);
});

void test('degradeWidgetToolRequestAction starts an attributed fallback run when idle', async () => {
  const harness = createStartActionHarness();
  const originBadges: Array<string | undefined> = [];

  const result = await degradeWidgetToolRequestAction({
    request: {
      toolName: 'write_file',
      args: { path: 'notes.md', content: 'draft' },
      scopeHandle: 'scope-degrade-1',
    },
    threadId: THREAD_ID_VALUE,
    rejection: {
      ok: false,
      errorCode: 'approval_required',
      error: 'tool "write_file" requires user approval',
    },
    cancelState: { phase: 'idle', activeRunId: null },
    startClient: harness.client,
    interjectClient: {
      async interject() {
        assert.fail('idle path must not steer');
      },
      async cancelInterject() {
        assert.fail('idle path must not cancel steers');
      },
      async flushInterject() {
        assert.fail('idle path must not flush steers');
      },
    },
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    appendOptimisticUserMessage(prompt: string, origin?: 'artifact_frame') {
      harness.appendOptimisticUserMessage(prompt);
      originBadges.push(origin);
    },
    logCommandFailure: harness.logCommandFailure,
    prepareStartRequest: async (request) => request,
    startRequestInFlight: { current: false },
    tryConsumeBudget: () => true,
  });

  // 프레임에는 강등 사실이 담긴 데이터 거부가 돌아간다 — 결과 직행 금지
  assert.deepEqual(result, {
    ok: false,
    errorCode: 'approval_required',
    error:
      'tool "write_file" requires user approval; degraded to a chat prompt pending user approval',
  });
  assert.equal(harness.startedRequests.length, 1);
  const started = harness.startedRequests[0]!;
  assert.equal('prompt' in started && typeof started.prompt === 'string', true);
  if ('prompt' in started) {
    assert.match(started.prompt, /write_file/);
    assert.match(started.prompt, /notes\.md/);
  }
  assert.equal(started.promptOrigin, 'artifact_frame');
  assert.equal(started.displayPrompt, '아티팩트가 "write_file" 실행을 요청함');
  // 낙관 말풍선도 아티팩트 발 귀속으로 그려진다
  assert.deepEqual(harness.optimisticPrompts, [
    '아티팩트가 "write_file" 실행을 요청함',
  ]);
  assert.deepEqual(originBadges, ['artifact_frame']);
  assert.deepEqual(harness.logFailures, []);
});

void test('degradeWidgetToolRequestAction steers the active run instead of starting a new one', async () => {
  const harness = createStartActionHarness();
  const steered: unknown[] = [];

  const result = await degradeWidgetToolRequestAction({
    request: {
      toolName: 'write_file',
      args: {},
      scopeHandle: 'scope-degrade-2',
    },
    threadId: THREAD_ID_VALUE,
    rejection: {
      ok: false,
      errorCode: 'approval_required',
      error: 'needs approval',
    },
    cancelState: { phase: 'running', activeRunId: 'run-9' },
    startClient: {
      async start() {
        assert.fail('running path must not start a new run');
      },
    },
    interjectClient: {
      async interject(request) {
        steered.push(request);
        return { requestId: 'req-9', receivedSeq: 1 };
      },
      async cancelInterject() {
        assert.fail('cancel should not run');
      },
      async flushInterject() {
        assert.fail('flush should not run');
      },
    },
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    logCommandFailure: harness.logCommandFailure,
    startRequestInFlight: { current: false },
    tryConsumeBudget: () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    errorCode: 'approval_required',
    error: 'needs approval; degraded to a steer in the active run',
  });
  assert.equal(steered.length, 1);
  // 스티어는 말풍선을 만들지 않는다 (기존 interject 규약)
  assert.deepEqual(harness.optimisticPrompts, []);
});

void test('degradeWidgetToolRequestAction returns the plain rejection when the prompt budget is exhausted', async () => {
  const harness = createStartActionHarness();

  const rejection = {
    ok: false as const,
    errorCode: 'approval_required' as const,
    error: 'needs approval',
  };
  const result = await degradeWidgetToolRequestAction({
    request: { toolName: 'write_file', args: {}, scopeHandle: 'scope-x' },
    threadId: THREAD_ID_VALUE,
    rejection,
    cancelState: { phase: 'idle', activeRunId: null },
    startClient: {
      async start() {
        assert.fail('exhausted budget must not start a run');
      },
    },
    interjectClient: {
      async interject() {
        assert.fail('exhausted budget must not steer');
      },
      async cancelInterject() {
        assert.fail('cancel should not run');
      },
      async flushInterject() {
        assert.fail('flush should not run');
      },
    },
    dispatch: harness.dispatch,
    clearSessionError: harness.clearSessionError,
    appendOptimisticUserMessage: harness.appendOptimisticUserMessage,
    logCommandFailure: harness.logCommandFailure,
    startRequestInFlight: { current: false },
    tryConsumeBudget: () => false,
  });

  assert.deepEqual(result, rejection);
  assert.deepEqual(harness.dispatched, []);
  assert.deepEqual(harness.optimisticPrompts, []);
});

void test('cancelSteerAction removes the queued steer after the daemon acknowledges', async () => {
  const dispatched: RunSessionStateAction[] = [];
  const cancelled: unknown[] = [];

  await cancelSteerAction({
    client: {
      async interject() {
        assert.fail('interject should not run on cancel');
      },
      async cancelInterject(request) {
        cancelled.push(request);
        return { cancelled: true };
      },
      async flushInterject() {
        assert.fail('flush should not run on the cancel path');
      },
    },
    dispatch(action) {
      dispatched.push(action);
    },
    activeRunId: 'run-1',
    receivedSeq: 3,
    logCommandFailure() {
      assert.fail('cancel path should not log failure');
    },
  });

  assert.deepEqual(cancelled, [{ runId: 'run-1', receivedSeq: 3 }]);
  assert.deepEqual(dispatched, [{ type: 'steer_cancelled', receivedSeq: 3 }]);
});

void test('flushSteersAction marks the queue when the daemon confirms the flush', async () => {
  const dispatched: RunSessionStateAction[] = [];
  const flushed: unknown[] = [];

  await flushSteersAction({
    client: {
      async interject() {
        assert.fail('interject should not run on flush');
      },
      async cancelInterject() {
        assert.fail('cancel should not run on flush');
      },
      async flushInterject(request) {
        flushed.push(request);
        return { flushed: true };
      },
    },
    dispatch(action) {
      dispatched.push(action);
    },
    activeRunId: 'run-1',
    logCommandFailure() {
      assert.fail('flush accept path should not log failure');
    },
  });

  assert.deepEqual(flushed, [{ runId: 'run-1' }]);
  assert.deepEqual(dispatched, [{ type: 'steer_flush_requested' }]);
});

void test('flushSteersAction stays quiet when the queue already drained (flushed=false)', async () => {
  const dispatched: RunSessionStateAction[] = [];

  await flushSteersAction({
    client: {
      async interject() {
        assert.fail('interject should not run on flush');
      },
      async cancelInterject() {
        assert.fail('cancel should not run on flush');
      },
      async flushInterject() {
        return { flushed: false };
      },
    },
    dispatch(action) {
      dispatched.push(action);
    },
    activeRunId: 'run-1',
    logCommandFailure() {
      assert.fail('flushed=false is a normal race, not a failure');
    },
  });

  assert.deepEqual(dispatched, []);
});

void test('flushSteersAction logs and swallows transport failures', async () => {
  const dispatched: RunSessionStateAction[] = [];
  const failures: string[] = [];

  await flushSteersAction({
    client: {
      async interject() {
        assert.fail('interject should not run on flush');
      },
      async cancelInterject() {
        assert.fail('cancel should not run on flush');
      },
      async flushInterject() {
        throw new Error('socket closed');
      },
    },
    dispatch(action) {
      dispatched.push(action);
    },
    activeRunId: 'run-1',
    logCommandFailure(_context, message) {
      failures.push(message);
    },
  });

  assert.deepEqual(dispatched, []);
  assert.deepEqual(failures, ['socket closed']);
});

void test('interjectPromptAction keeps rejected steer prompts out of the transcript', async () => {
  const dispatched: RunSessionStateAction[] = [];
  const failures: string[] = [];

  await assert.rejects(
    () =>
      interjectPromptAction({
        client: {
          async interject() {
            throw new Error('mid-run steer is not enabled');
          },
          async cancelInterject() {
            assert.fail('cancel should not run here');
          },
          async flushInterject() {
            assert.fail('flush should not run here');
          },
        },
        dispatch(action) {
          dispatched.push(action);
        },
        clearSessionError() {},
        activeRunId: 'run-1',
        threadId: THREAD_ID_VALUE,
        prompt: 'please steer',
        logCommandFailure(_context, message) {
          failures.push(message);
        },
      }),
    /mid-run steer is not enabled/,
  );

  // 거절된 스티어는 큐에도 대화에도 남지 않는다
  assert.deepEqual(dispatched, []);
  assert.deepEqual(failures, ['mid-run steer is not enabled']);
});
