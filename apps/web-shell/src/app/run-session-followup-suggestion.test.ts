import assert from 'node:assert/strict';
import test from 'node:test';

import { readFollowupSuggestion } from './run-session-message-effects.js';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';

function toolCallMessage(
  tool: string,
  args: Record<string, unknown>,
): RunChannelServerMessage {
  return {
    type: 'run.event',
    event: {
      type: 'tool_call',
      threadId: 'thread-1',
      payload: { callId: 'call-1', step: 1, tool, args },
    },
  } as RunChannelServerMessage;
}

void test('a suggest_followup call surfaces its prompt for the composer', () => {
  assert.equal(
    readFollowupSuggestion(
      toolCallMessage('suggest_followup', {
        prompt: '최근 폴더가 실제로 쌓이는지 확인해 주세요',
      }),
    ),
    '최근 폴더가 실제로 쌓이는지 확인해 주세요',
  );
});

void test('other tool calls do not produce a suggestion', () => {
  assert.equal(
    readFollowupSuggestion(toolCallMessage('read_file', { path: 'a.ts' })),
    null,
  );
});

void test('a blank suggestion is refused so the composer keeps its own hint', () => {
  assert.equal(
    readFollowupSuggestion(
      toolCallMessage('suggest_followup', { prompt: '   ' }),
    ),
    null,
  );
  assert.equal(
    readFollowupSuggestion(toolCallMessage('suggest_followup', { prompt: 42 })),
    null,
  );
});

void test('messages that are not tool calls are ignored', () => {
  assert.equal(
    readFollowupSuggestion({
      type: 'run.error',
      code: 'internal',
      message: 'boom',
    } as RunChannelServerMessage),
    null,
  );
});
