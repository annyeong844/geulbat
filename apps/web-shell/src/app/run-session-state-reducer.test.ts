import test from 'node:test';
import assert from 'node:assert/strict';

import { selectVisibleRunState } from './run-session-state-selectors.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';

import {
  OTHER_THREAD_ID_VALUE,
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';

void test('starting a new chat clears the unowned draft lane and prior session error', () => {
  const starting = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'run_start_requested',
    threadId: null,
  });
  const failed = reduceRunSessionState(starting, {
    type: 'session_error_recorded',
    message: 'old websocket failure',
  });
  const fresh = reduceRunSessionState(failed, {
    type: 'new_session_started',
  });

  assert.equal(fresh.newThreadRunLane?.phase, 'idle');
  assert.equal(fresh.newThreadRunLane?.activeRunView.streamError, null);
  assert.equal(fresh.sessionError, null);
});

void test('run usage updates land on the active run view and reset per run', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-1',
  });
  const usage = { inputTokens: 9800, outputTokens: 252, cachedInputTokens: 0 };
  const updated = reduceRunSessionState(running, {
    type: 'run_usage_updated',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    usage,
  });

  assert.equal(updated.activeRunView.usageTotals, usage);
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: updated,
    }).usageTotals,
    usage,
  );

  // 다른 스레드의 usage는 활성 런 뷰를 오염시키지 않는다
  const mismatched = reduceRunSessionState(updated, {
    type: 'run_usage_updated',
    runId: 'run-1',
    threadId: OTHER_THREAD_ID_VALUE,
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  });
  assert.equal(mismatched.activeRunView.usageTotals, usage);

  // 다음 런 시작 시 초기화
  const nextRun = reduceRunSessionState(mismatched, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  assert.equal(nextRun.activeRunView.usageTotals, null);
});

void test('provider admission status stays scoped to the exact run and clears when output resumes', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: 'run-1',
    },
  );
  const waiting = reduceRunSessionState(running, {
    type: 'provider_runtime_updated',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    providerRuntime: {
      phase: 'rate_limit_waiting',
      observedAt: '2026-07-23T11:00:00.000Z',
    },
  });

  assert.deepEqual(waiting.activeRunView.providerRuntime, {
    phase: 'rate_limit_waiting',
    observedAt: '2026-07-23T11:00:00.000Z',
  });
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: waiting,
    }).providerRuntime?.phase,
    'rate_limit_waiting',
  );

  const stale = reduceRunSessionState(waiting, {
    type: 'provider_runtime_updated',
    runId: 'run-stale',
    threadId: THREAD_ID_VALUE,
    providerRuntime: {
      phase: 'provider_waiting',
      observedAt: '2026-07-23T11:00:01.000Z',
    },
  });
  assert.equal(stale, waiting);

  const resumed = reduceRunSessionState(waiting, {
    type: 'assistant_text_streamed',
    threadId: THREAD_ID_VALUE,
    target: 'transcript',
    text: '다시 응답 중',
  });
  assert.equal(resumed.activeRunView.providerRuntime, null);

  const nextRun = reduceRunSessionState(waiting, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  assert.equal(nextRun.activeRunView.providerRuntime, null);
});

void test('context usage snapshots persist per thread until the next exact measurement replaces them', () => {
  const measured = {
    state: 'measured' as const,
    quality: 'exact' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
    requestBytes: 510_000,
  };
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    { type: 'run_started', threadId: THREAD_ID_VALUE, runId: RUN_ID },
  );
  const measuredState = reduceRunSessionState(running, {
    type: 'run_context_usage_updated',
    threadId: THREAD_ID_VALUE,
    contextUsage: measured,
  });
  const sameModelUnknown = reduceRunSessionState(measuredState, {
    type: 'run_context_usage_updated',
    threadId: THREAD_ID_VALUE,
    contextUsage: {
      state: 'measured',
      quality: 'unknown',
      modelId: measured.modelId,
      requestBytes: 520_000,
    },
  });
  assert.equal(sameModelUnknown, measuredState);

  const settled = reduceRunSessionState(sameModelUnknown, {
    type: 'run_settled_success',
  });
  const withOtherThread = reduceRunSessionState(settled, {
    type: 'run_context_usage_updated',
    threadId: OTHER_THREAD_ID_VALUE,
    contextUsage: {
      state: 'compacted',
      modelId: 'grok-4.5',
      inputTokens: 425_000,
      contextWindow: 500_000,
      thresholdTokens: 425_000,
    },
  });

  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: withOtherThread,
    }).contextUsage,
    measured,
  );
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: OTHER_THREAD_ID_VALUE,
      state: withOtherThread,
    }).contextUsage?.state,
    'compacted',
  );

  const modelSwitched = reduceRunSessionState(withOtherThread, {
    type: 'run_context_usage_updated',
    threadId: THREAD_ID_VALUE,
    contextUsage: {
      state: 'measured',
      quality: 'unknown',
      modelId: 'grok-4.5',
      requestBytes: 600_000,
    },
  });
  assert.deepEqual(modelSwitched.contextUsageByThread[THREAD_ID_VALUE], {
    state: 'measured',
    quality: 'unknown',
    modelId: 'grok-4.5',
    requestBytes: 600_000,
  });

  const nextRun = reduceRunSessionState(withOtherThread, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  assert.equal(
    selectVisibleRunState({
      selectedThreadId: THREAD_ID_VALUE,
      state: nextRun,
    }).contextUsage,
    measured,
  );
  assert.equal(
    nextRun.contextUsageByThread[OTHER_THREAD_ID_VALUE]?.modelId,
    'grok-4.5',
  );
});

void test('approval submit failure preserves pending approval and records a visible error until cleared', () => {
  const withPendingApproval = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: 'run-1',
      },
    ),
    {
      type: 'approval_requested',
      threadId: THREAD_ID,
      pendingApproval: makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
      }),
    },
  );

  const withApprovalError = reduceRunSessionState(withPendingApproval, {
    type: 'approval_submit_failed',
    message: '[internal] approval transport down',
  });
  const cleared = reduceRunSessionState(withApprovalError, {
    type: 'approval_cleared',
  });

  assert.equal(
    withApprovalError.activeRunView.pendingApproval?.callId,
    'call-1',
  );
  assert.equal(
    withApprovalError.activeRunView.streamError,
    '[internal] approval transport down',
  );
  assert.equal(cleared.activeRunView.pendingApproval, null);
  assert.equal(cleared.activeRunView.streamError, null);
});

void test('multiple pending approvals are revealed one at a time as each is cleared', () => {
  const firstApproval = makeApprovalRequiredFixture({
    callId: 'approval-call-1',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const secondApproval = makeApprovalRequiredFixture({
    callId: 'approval-call-2',
    runId: RUN_ID,
    threadId: THREAD_ID,
  });
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    {
      type: 'run_started',
      threadId: THREAD_ID_VALUE,
      runId: RUN_ID,
    },
  );
  const withApprovals = reduceRunSessionState(
    reduceRunSessionState(running, {
      type: 'approval_requested',
      threadId: THREAD_ID_VALUE,
      pendingApproval: firstApproval,
    }),
    {
      type: 'approval_requested',
      threadId: THREAD_ID_VALUE,
      pendingApproval: secondApproval,
    },
  );

  assert.equal(withApprovals.activeRunView.pendingApproval, firstApproval);

  const afterFirstCleared = reduceRunSessionState(withApprovals, {
    type: 'approval_cleared',
    pendingApproval: firstApproval,
  });
  assert.equal(afterFirstCleared.activeRunView.pendingApproval, secondApproval);

  const afterSecondCleared = reduceRunSessionState(afterFirstCleared, {
    type: 'approval_cleared',
    pendingApproval: secondApproval,
  });
  assert.equal(afterSecondCleared.activeRunView.pendingApproval, null);
});

function runningWithSteer(text: string, receivedSeq: number) {
  const running = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'run_started',
    threadId: THREAD_ID,
    runId: RUN_ID,
  });
  return reduceRunSessionState(running, {
    type: 'steer_queued',
    runId: RUN_ID,
    threadId: THREAD_ID,
    steer: { receivedSeq, text },
  });
}

void test('a mid-run message appears pending immediately and waits for the next model request', () => {
  const queued = runningWithSteer('CSS부터요', 7);

  // 1단: 보낸 말은 바로 대화에 보이고, pendingSteerSeq가 반짝임과 클릭을
  // 소유한다. 모델 쪽에서는 여전히 다음 요청 전까지 큐에만 있다.
  assert.deepEqual(queued.activeRunView.pendingSteers, [
    { receivedSeq: 7, text: 'CSS부터요' },
  ]);
  assert.deepEqual(queued.activeRunView.transcriptEntries, [
    { kind: 'user_text', text: 'CSS부터요', pendingSteerSeq: 7 },
  ]);

  // 2단: 반짝이는 말풍선을 누르면 표시를 복제하지 않고 중단 요청만 건다.
  const flushed = reduceRunSessionState(queued, {
    type: 'steer_flush_requested',
    runId: RUN_ID,
  });
  assert.equal(flushed.activeRunView.pendingSteerFlushRequested, true);
  assert.deepEqual(flushed.activeRunView.transcriptEntries, [
    { kind: 'user_text', text: 'CSS부터요', pendingSteerSeq: 7 },
  ]);
});

void test('putting the same message on the conversation twice does not double it', () => {
  // 두 번 눌러도 같은 말이 두 줄이 되면 무엇이 반영될지 알 수 없다.
  const flushed = reduceRunSessionState(runningWithSteer('CSS부터요', 7), {
    type: 'steer_flush_requested',
    runId: RUN_ID,
  });
  const again = reduceRunSessionState(flushed, {
    type: 'steer_flush_requested',
    runId: RUN_ID,
  });
  assert.deepEqual(again.activeRunView.transcriptEntries, [
    { kind: 'user_text', text: 'CSS부터요', pendingSteerSeq: 7 },
  ]);
});

void test('the shimmer stops once the message is applied — whichever way it got there', () => {
  // (a) 대화에 올린 뒤 반영
  const flushed = reduceRunSessionState(runningWithSteer('CSS부터요', 7), {
    type: 'steer_flush_requested',
    runId: RUN_ID,
  });
  const appliedAfterFlush = reduceRunSessionState(flushed, {
    type: 'steer_applied',
    runId: RUN_ID,
    threadId: THREAD_ID,
    receivedSeqs: [7],
  });
  assert.deepEqual(appliedAfterFlush.activeRunView.transcriptEntries, [
    { kind: 'user_text', text: 'CSS부터요' },
  ]);
  assert.deepEqual(appliedAfterFlush.activeRunView.pendingSteers, []);
  assert.equal(
    appliedAfterFlush.activeRunView.pendingSteerFlushRequested,
    false,
  );

  // (b) 말풍선을 누르지 않았는데 모델이 다음 요청에서 먼저 읽은 경우에도
  // 같은 말의 반짝임만 꺼진다.
  const appliedWithoutFlush = reduceRunSessionState(
    runningWithSteer('CSS부터요', 7),
    {
      type: 'steer_applied',
      runId: RUN_ID,
      threadId: THREAD_ID,
      receivedSeqs: [7],
    },
  );
  assert.deepEqual(appliedWithoutFlush.activeRunView.transcriptEntries, [
    { kind: 'user_text', text: 'CSS부터요' },
  ]);
  assert.deepEqual(appliedWithoutFlush.activeRunView.pendingSteers, []);
});

void test('applying one of several queued messages leaves only the rest shimmering', () => {
  const first = runningWithSteer('첫 번째', 1);
  const both = reduceRunSessionState(first, {
    type: 'steer_queued',
    runId: RUN_ID,
    threadId: THREAD_ID,
    steer: { receivedSeq: 2, text: '두 번째' },
  });
  const flushed = reduceRunSessionState(both, {
    type: 'steer_flush_requested',
    runId: RUN_ID,
  });
  const applied = reduceRunSessionState(flushed, {
    type: 'steer_applied',
    runId: RUN_ID,
    threadId: THREAD_ID,
    receivedSeqs: [1],
  });

  // 반영된 것만 반짝임이 꺼지고, 남은 것은 계속 반짝인다.
  assert.deepEqual(applied.activeRunView.transcriptEntries, [
    { kind: 'user_text', text: '첫 번째' },
    { kind: 'user_text', text: '두 번째', pendingSteerSeq: 2 },
  ]);
  assert.deepEqual(applied.activeRunView.pendingSteers, [
    { receivedSeq: 2, text: '두 번째' },
  ]);
});

void test('undoing a message that is already on the conversation removes it too', () => {
  const cancelled = reduceRunSessionState(runningWithSteer('취소할 말', 7), {
    type: 'steer_cancelled',
    runId: RUN_ID,
    receivedSeq: 7,
  });

  // 아직 읽히지 않았으므로 대화에서도 사라진다. 읽힌 말이라면 대화의
  // 일부이므로 남아야 한다 — 그 구분이 `pendingSteerSeq`다.
  assert.deepEqual(cancelled.activeRunView.transcriptEntries, []);
  assert.deepEqual(cancelled.activeRunView.pendingSteers, []);
});
