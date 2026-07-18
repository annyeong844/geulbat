import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testThreadId } from '../../test-support/thread-id.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import {
  appendChildAssistantTranscriptEntry,
  appendChildUserTranscriptEntry,
} from './subagent-transcript.js';

void test('appendChildUserTranscriptEntry writes child prompt transcript entries', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-subagent-'));
  const threadId = testThreadId(51);

  await appendChildUserTranscriptEntry({
    workspaceRoot,
    threadId,
    prompt: 'inspect the parser boundary',
    modelPrompt:
      '<workspace-context>\nProject: project\nCurrent file: none\nSelection: none\n</workspace-context>\n\ninspect the parser boundary',
    timestamp: '2026-04-29T00:00:00.000Z',
  });

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(typeof entries[0]?.entryId, 'string');
  assert.notEqual(entries[0]?.entryId, '');
  assert.deepEqual(entries, [
    {
      entryId: entries[0]?.entryId,
      role: 'user',
      content: 'inspect the parser boundary',
      timestamp: '2026-04-29T00:00:00.000Z',
      metadata: {
        hiddenPrompt:
          '<workspace-context>\nProject: project\nCurrent file: none\nSelection: none\n</workspace-context>\n\ninspect the parser boundary',
      },
    },
  ]);
});

void test('appendChildAssistantTranscriptEntry writes final-answer source run metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-subagent-'));
  const threadId = testThreadId(52);

  await appendChildAssistantTranscriptEntry({
    workspaceRoot,
    threadId,
    childRunId: 'child-run-transcript',
    content: 'child result',
    timestamp: '2026-04-29T00:00:01.000Z',
  });

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(typeof entries[0]?.entryId, 'string');
  assert.notEqual(entries[0]?.entryId, '');
  assert.deepEqual(entries, [
    {
      entryId: entries[0]?.entryId,
      role: 'assistant',
      content: 'child result',
      timestamp: '2026-04-29T00:00:01.000Z',
      metadata: {
        phase: 'final_answer',
        sourceRunId: 'child-run-transcript',
      },
    },
  ]);
});
