import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_SESSION_STREAM_BATCH_WINDOW_MS,
  createRunSessionStreamBatchController,
} from './run-session-stream-batch.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

void test('createRunSessionStreamBatchController flushes queued stream and display effects in order', async () => {
  const actions: RunSessionStateAction[] = [];
  const controller = createRunSessionStreamBatchController({
    readDispatch: () => (action) => {
      actions.push(action);
    },
  });

  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'transcript',
    text: 'hello ',
  });
  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'transcript',
    text: 'world',
  });
  controller.queueDisplayEffect({
    kind: 'transcript_activity_added',
    runId: 'run-1',
    threadId: 'thread-1',
    streamedToolCallId: 'call-1',
    entry: {
      kind: 'tool_activity',
      tool: 'read_file',
      state: 'running',
      callId: 'call-1',
    },
    computerFilesMayHaveChanged: false,
  });
  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'answer',
    text: 'done',
  });

  assert.deepEqual(actions, [
    {
      type: 'assistant_text_streamed',
      threadId: 'thread-1',
      target: 'transcript',
      text: 'hello ',
    },
  ]);

  await new Promise((resolve) =>
    setTimeout(resolve, RUN_SESSION_STREAM_BATCH_WINDOW_MS + 10),
  );

  assert.deepEqual(actions, [
    {
      type: 'assistant_text_streamed',
      threadId: 'thread-1',
      target: 'transcript',
      text: 'hello ',
    },
    {
      type: 'assistant_text_streamed',
      threadId: 'thread-1',
      target: 'transcript',
      text: 'world',
    },
    {
      type: 'transcript_activity_added',
      runId: 'run-1',
      threadId: 'thread-1',
      streamedToolCallId: 'call-1',
      entry: {
        kind: 'tool_activity',
        tool: 'read_file',
        state: 'running',
        callId: 'call-1',
      },
    },
    {
      type: 'assistant_text_streamed',
      threadId: 'thread-1',
      target: 'answer',
      text: 'done',
    },
  ]);
});

void test('createRunSessionStreamBatchController clearPendingStreamEffects cancels scheduled flush and drops buffered effects', async () => {
  const actions: RunSessionStateAction[] = [];
  const controller = createRunSessionStreamBatchController({
    readDispatch: () => (action) => {
      actions.push(action);
    },
  });

  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'transcript',
    text: 'hello ',
  });
  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'transcript',
    text: 'world',
  });

  controller.clearPendingStreamEffects();

  await new Promise((resolve) =>
    setTimeout(resolve, RUN_SESSION_STREAM_BATCH_WINDOW_MS + 10),
  );

  assert.deepEqual(actions, [
    {
      type: 'assistant_text_streamed',
      threadId: 'thread-1',
      target: 'transcript',
      text: 'hello ',
    },
  ]);
});

void test('coalesces same-target deltas that arrive within the batch window into a single dispatch', async () => {
  const actions: RunSessionStateAction[] = [];
  const controller = createRunSessionStreamBatchController({
    readDispatch: () => (action) => {
      actions.push(action);
    },
  });

  // First delta dispatches immediately (preserves first-token latency).
  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'answer',
    text: 'a',
  });

  // Wait long enough that a short (one-frame) window would have already flushed
  // and left the controller idle, but short enough to remain inside the batch window.
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Two more same-target deltas arrive within the window: they must be buffered
  // and coalesced into ONE dispatch instead of each forcing its own render.
  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'answer',
    text: 'b',
  });
  controller.queueStreamedTextEffect({
    kind: 'assistant_text_streamed',
    threadId: 'thread-1',
    target: 'answer',
    text: 'c',
  });

  await new Promise((resolve) => setTimeout(resolve, 70));

  // Immediate first delta + one coalesced flush of 'bc' = 2 dispatches, not 3.
  assert.equal(actions.length, 2);
  assert.equal(
    (
      actions[1] as Extract<
        RunSessionStateAction,
        { type: 'assistant_text_streamed' }
      >
    ).text,
    'bc',
  );
});

void test('coalesces adjacent tool output by call and stream while preserving stream order', async () => {
  const actions: RunSessionStateAction[] = [];
  const controller = createRunSessionStreamBatchController({
    readDispatch: () => (action) => {
      actions.push(action);
    },
  });

  controller.queueStreamedToolOutputEffect({
    kind: 'tool_output_streamed',
    threadId: 'thread-1',
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'a',
  });
  controller.queueStreamedToolOutputEffect({
    kind: 'tool_output_streamed',
    threadId: 'thread-1',
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'b',
  });
  controller.queueStreamedToolOutputEffect({
    kind: 'tool_output_streamed',
    threadId: 'thread-1',
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stdout',
    text: 'c',
  });
  controller.queueStreamedToolOutputEffect({
    kind: 'tool_output_streamed',
    threadId: 'thread-1',
    callId: 'call-exec',
    tool: 'exec_command',
    stream: 'stderr',
    text: 'warn',
  });

  assert.deepEqual(actions, [
    {
      type: 'tool_output_streamed',
      threadId: 'thread-1',
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stdout',
      text: 'a',
    },
  ]);

  await new Promise((resolve) =>
    setTimeout(resolve, RUN_SESSION_STREAM_BATCH_WINDOW_MS + 10),
  );

  assert.deepEqual(actions.slice(1), [
    {
      type: 'tool_output_streamed',
      threadId: 'thread-1',
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stdout',
      text: 'bc',
    },
    {
      type: 'tool_output_streamed',
      threadId: 'thread-1',
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stderr',
      text: 'warn',
    },
  ]);
});
