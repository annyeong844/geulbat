import assert from 'node:assert/strict';
import test from 'node:test';

import { toolMessage } from '../../test-support/transcript-message-fixtures.js';
import {
  getRunTranscriptEntryBaseKey,
  getThreadMessageBaseKey,
} from './assistant-transcript-content.js';

void test('message render identity uses entryId instead of copying message content', () => {
  const message = toolMessage(
    'stable-entry-id',
    'tool_result',
    'LARGE_OUTPUT_SENTINEL'.repeat(10_000),
  );

  assert.equal(getThreadMessageBaseKey(message), 'message:stable-entry-id');
  assert.equal(
    getRunTranscriptEntryBaseKey({
      kind: 'assistant_text',
      text: 'STREAMING_OUTPUT_SENTINEL'.repeat(10_000),
    }),
    'assistant_text',
  );
  assert.equal(
    getRunTranscriptEntryBaseKey({
      kind: 'tool_activity',
      tool: 'read_file',
      state: 'running',
    }),
    getRunTranscriptEntryBaseKey({
      kind: 'tool_activity',
      tool: 'read_file',
      state: 'completed',
    }),
  );
});
