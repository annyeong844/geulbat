import test from 'node:test';
import assert from 'node:assert/strict';

import { selectVisibleRunState } from './run-session-state-selectors.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';

import {
  OTHER_THREAD_ID_VALUE,
  RUN_ID,
  THREAD_ID,
  THREAD_ID_VALUE,
} from '../test-support/run-session-fixtures.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';

void test('terminal tool activity clears only the matching pending approval and reveals the next one', () => {
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
      runId: RUN_ID,
      threadId: THREAD_ID_VALUE,
      pendingApproval: firstApproval,
    }),
    {
      type: 'approval_requested',
      runId: RUN_ID,
      threadId: THREAD_ID_VALUE,
      pendingApproval: secondApproval,
    },
  );

  const afterStaleToolSettled = reduceRunSessionState(withApprovals, {
    type: 'transcript_activity_added',
    runId: 'run-stale',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'tool_activity',
      tool: 'write_file',
      state: 'completed',
      callId: firstApproval.callId,
    },
  });
  assert.equal(
    afterStaleToolSettled.activeRunView.pendingApproval,
    firstApproval,
  );

  const afterToolSettled = reduceRunSessionState(afterStaleToolSettled, {
    type: 'transcript_activity_added',
    runId: RUN_ID,
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'tool_activity',
      tool: 'write_file',
      state: 'completed',
      callId: firstApproval.callId,
    },
  });

  assert.equal(afterToolSettled.activeRunView.pendingApproval, secondApproval);
  assert.deepEqual(afterToolSettled.activeRunView.pendingApprovals, [
    secondApproval,
  ]);
});

void test('run transcript entries stay structured instead of flattening tool events into commentary text', () => {
  const withEntries = reduceRunSessionState(
    reduceRunSessionState(
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
        type: 'assistant_text_streamed',
        threadId: THREAD_ID_VALUE,
        target: 'transcript',
        text: 'Thinking...',
      },
    ),
    {
      type: 'transcript_activity_added',
      runId: 'run-1',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'tool_activity',
        tool: 'write_file',
        state: 'running',
      },
    },
  );

  const finished = reduceRunSessionState(withEntries, {
    type: 'transcript_activity_added',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'tool_activity',
      tool: 'write_file',
      state: 'completed',
    },
  });

  assert.deepEqual(finished.activeRunView.transcriptEntries, [
    { kind: 'assistant_text', text: 'Thinking...' },
    { kind: 'tool_activity', tool: 'write_file', state: 'running' },
    { kind: 'tool_activity', tool: 'write_file', state: 'completed' },
  ]);
});

void test('subagent activity appends to the active transcript when the parent thread is visible', () => {
  const state = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'spawned',
      },
    },
  );

  assert.deepEqual(state.activeRunView.transcriptEntries, [
    {
      kind: 'subagent_activity',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'spawned',
    },
  ]);
  assert.deepEqual(state.backgroundNotificationsByThread, {});
});

void test('subagent activity falls back to thread-scoped background notifications when the thread is inactive', () => {
  const state = reduceRunSessionState(createInitialRunSessionState(), {
    type: 'subagent_activity_added',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-1',
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  });

  assert.deepEqual(state.activeRunView.transcriptEntries, []);
  assert.deepEqual(state.backgroundNotificationsByThread, {
    [THREAD_ID_VALUE]: [
      {
        kind: 'subagent_activity',
        deliveryId: 'delivery-1',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
  });
});

void test('subagent terminal replay with the same deliveryId is deduped in the active transcript', () => {
  const initial = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-dedupe',
        parentRunId: RUN_ID,
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    },
  );

  const deduped = reduceRunSessionState(initial, {
    type: 'subagent_activity_added',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-dedupe',
      parentRunId: RUN_ID,
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  });

  assert.deepEqual(deduped.activeRunView.transcriptEntries, [
    {
      kind: 'subagent_activity',
      deliveryId: 'delivery-dedupe',
      parentRunId: RUN_ID,
      childRunId: 'run-child-1',
      subagentType: 'worker',
      state: 'completed',
    },
  ]);
  assert.deepEqual(deduped.backgroundNotificationsByThread, {});
});

void test('subagent terminal activity remains visible after the parent run settles', () => {
  const withTerminalActivity = reduceRunSessionState(
    reduceRunSessionState(
      reduceRunSessionState(createInitialRunSessionState(), {
        type: 'run_start_requested',
        threadId: THREAD_ID_VALUE,
      }),
      {
        type: 'run_started',
        threadId: THREAD_ID_VALUE,
        runId: RUN_ID,
      },
    ),
    {
      type: 'subagent_activity_added',
      threadId: THREAD_ID_VALUE,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-before-settle',
        parentRunId: RUN_ID,
        childRunId: 'run-child-before-settle',
        subagentType: 'worker',
        state: 'completed',
        result: 'done before parent settle',
      },
    },
  );

  const settled = reduceRunSessionState(withTerminalActivity, {
    type: 'run_settled_success',
  });

  assert.deepEqual(settled.backgroundNotificationsByThread, {
    [THREAD_ID_VALUE]: [
      {
        kind: 'subagent_activity',
        deliveryId: 'delivery-before-settle',
        parentRunId: RUN_ID,
        childRunId: 'run-child-before-settle',
        subagentType: 'worker',
        state: 'completed',
        result: 'done before parent settle',
      },
    ],
  });
});

void test('artifact_activated preserves finalAnswerText and promotes the committed artifact ref', () => {
  const withFinalAnswer = reduceRunSessionState(
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
      type: 'assistant_text_streamed',
      threadId: THREAD_ID_VALUE,
      target: 'answer',
      text: '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
    },
  );

  const committed = reduceRunSessionState(withFinalAnswer, {
    type: 'artifact_activated',
    threadId: THREAD_ID_VALUE,
    artifact: {
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: '요약',
      contentHash: 'hash',
      createdAt: '2026-03-24T00:00:01.000Z',
      createdByRunId: 'run-1',
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: null,
    },
  });

  assert.equal(
    committed.activeRunView.finalAnswerText,
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# title\n<!-- /GEULBAT_ARTIFACT -->',
  );
  assert.deepEqual(committed.activeRunView.activeArtifactRef, {
    artifactId: 'art_1',
    version: 1,
  });
});

void test('steer flush request marks the queue and clears on apply or empty', () => {
  const running = reduceRunSessionState(
    reduceRunSessionState(createInitialRunSessionState(), {
      type: 'run_start_requested',
      threadId: THREAD_ID_VALUE,
    }),
    { type: 'run_started', threadId: THREAD_ID_VALUE, runId: 'run-1' },
  );

  // 큐가 비어 있으면 플러시 요청은 무시된다
  const flushWithoutQueue = reduceRunSessionState(running, {
    type: 'steer_flush_requested',
    runId: 'run-1',
  });
  assert.equal(
    flushWithoutQueue.activeRunView.pendingSteerFlushRequested,
    false,
  );

  const queuedOne = reduceRunSessionState(running, {
    type: 'steer_queued',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    steer: { receivedSeq: 1, text: 'first steer' },
  });
  const queuedTwo = reduceRunSessionState(queuedOne, {
    type: 'steer_queued',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    steer: { receivedSeq: 2, text: 'second steer' },
  });
  const staleCancel = reduceRunSessionState(queuedTwo, {
    type: 'steer_cancelled',
    runId: 'run-previous',
    receivedSeq: 1,
  });
  const staleFlush = reduceRunSessionState(queuedTwo, {
    type: 'steer_flush_requested',
    runId: 'run-previous',
  });
  assert.equal(staleCancel, queuedTwo);
  assert.equal(staleFlush, queuedTwo);

  const flushRequested = reduceRunSessionState(queuedTwo, {
    type: 'steer_flush_requested',
    runId: 'run-1',
  });
  assert.equal(flushRequested.activeRunView.pendingSteerFlushRequested, true);

  // 소비 1건이면 플러시 플래그는 목적을 다해 내려간다
  const applied = reduceRunSessionState(flushRequested, {
    type: 'steer_applied',
    runId: 'run-1',
    threadId: THREAD_ID_VALUE,
    receivedSeqs: [1],
  });
  assert.equal(applied.activeRunView.pendingSteerFlushRequested, false);
  assert.deepEqual(
    applied.activeRunView.pendingSteers.map((steer) => steer.receivedSeq),
    [2],
  );

  // 취소로 큐가 완전히 비면 플래그도 내려간다
  const flushAgain = reduceRunSessionState(applied, {
    type: 'steer_flush_requested',
    runId: 'run-1',
  });
  assert.equal(flushAgain.activeRunView.pendingSteerFlushRequested, true);
  const emptied = reduceRunSessionState(flushAgain, {
    type: 'steer_cancelled',
    runId: 'run-1',
    receivedSeq: 2,
  });
  assert.equal(emptied.activeRunView.pendingSteers.length, 0);
  assert.equal(emptied.activeRunView.pendingSteerFlushRequested, false);
});

void test('tool_call_args_streamed accumulates into a live entry and the full tool_call closes it', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-stream-1',
  });

  const first = reduceRunSessionState(running, {
    type: 'tool_call_args_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call_viz',
    tool: 'visualize',
    argsDelta: '{"code":"<svg',
  });
  const second = reduceRunSessionState(first, {
    type: 'tool_call_args_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call_viz',
    tool: 'visualize',
    argsDelta: '></svg>"}',
  });

  assert.deepEqual(second.activeRunView.streamingToolCall, {
    callId: 'call_viz',
    tool: 'visualize',
    argsText: '{"code":"<svg></svg>"}',
  });
  // 스트리밍 중에는 라이브 꼬리 엔트리로 보인다
  const visible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: second,
  });
  assert.deepEqual(visible.transcriptEntries.at(-1), {
    kind: 'tool_activity',
    tool: 'visualize',
    state: 'running',
    argsText: '{"code":"<svg></svg>"}',
  });

  // 다른 스레드의 델타는 무시
  const mismatched = reduceRunSessionState(second, {
    type: 'tool_call_args_streamed',
    threadId: OTHER_THREAD_ID_VALUE,
    callId: 'call_viz',
    tool: 'visualize',
    argsDelta: 'x',
  });
  assert.equal(
    mismatched.activeRunView.streamingToolCall?.argsText,
    '{"code":"<svg></svg>"}',
  );

  // 완성본 tool_call이 스트리밍을 닫고 일반 엔트리가 대체한다
  const settled = reduceRunSessionState(mismatched, {
    type: 'transcript_activity_added',
    runId: 'run-stream-1',
    threadId: THREAD_ID_VALUE,
    streamedToolCallId: 'call_viz',
    entry: {
      kind: 'tool_activity',
      tool: 'visualize',
      state: 'running',
      args: { code: '<svg></svg>' },
    },
  });
  assert.equal(settled.activeRunView.streamingToolCall, null);
  const settledVisible = selectVisibleRunState({
    selectedThreadId: THREAD_ID_VALUE,
    state: settled,
  });
  assert.equal(
    settledVisible.transcriptEntries.filter(
      (entry) => entry.kind === 'tool_activity' && entry.tool === 'visualize',
    ).length,
    1,
  );
});

void test('tool_output_streamed accumulates only on the matching live tool call', () => {
  const initial = createInitialRunSessionState();
  const starting = reduceRunSessionState(initial, {
    type: 'run_start_requested',
    threadId: THREAD_ID_VALUE,
  });
  const running = reduceRunSessionState(starting, {
    type: 'run_started',
    threadId: THREAD_ID_VALUE,
    runId: 'run-stream-output',
  });
  const withCall = reduceRunSessionState(running, {
    type: 'transcript_activity_added',
    runId: 'run-stream-output',
    threadId: THREAD_ID_VALUE,
    entry: {
      kind: 'tool_activity',
      tool: 'exec_command',
      state: 'running',
      callId: 'call-exec',
    },
  });
  const withStdout = reduceRunSessionState(withCall, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'hello ',
  });
  const withBothStreams = reduceRunSessionState(withStdout, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stderr',
    text: 'warning',
  });
  const completed = reduceRunSessionState(withBothStreams, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'world',
  });

  assert.deepEqual(completed.activeRunView.transcriptEntries[0], {
    kind: 'tool_activity',
    tool: 'exec_command',
    state: 'running',
    callId: 'call-exec',
    output: {
      stdout: 'hello world',
      stderr: 'warning',
    },
  });

  const mismatched = reduceRunSessionState(completed, {
    type: 'tool_output_streamed',
    threadId: THREAD_ID_VALUE,
    callId: 'another-call',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'must-not-appear',
  });
  assert.equal(mismatched, completed);
});
