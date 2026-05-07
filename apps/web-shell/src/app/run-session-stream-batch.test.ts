import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_SESSION_STREAM_BATCH_WINDOW_MS,
  createRunSessionStreamBatchController,
} from './run-session-stream-batch.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

void test('createRunSessionStreamBatchController flushes queued streamed effects in order', async () => {
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
