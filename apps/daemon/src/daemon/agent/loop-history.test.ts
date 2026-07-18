import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FunctionCall } from '../llm/index.js';
import { commitThreadArtifactVersion } from '../sessions/artifact-store.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import {
  appendAssistantTextToHistory,
  appendFunctionCallsToHistory,
  appendInterjectToHistory,
  createAgentLoopHistoryPort,
  loadInitialHistory,
  persistSingleInterjectToTranscript,
} from './loop-history.js';
import { testThreadId } from '../../test-support/thread-id.js';

void test('loadInitialHistory reuses a matching trailing user prompt from transcript', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-history-'));
  const threadId = testThreadId(41);

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'visible prompt',
    timestamp: '2026-03-30T00:00:00.000Z',
    metadata: {
      hiddenPrompt: 'canonical prompt',
    },
  });

  const history = await loadInitialHistory(
    workspaceRoot,
    threadId,
    'canonical prompt',
  );

  assert.deepEqual(history, [{ kind: 'user', text: 'canonical prompt' }]);
});

void test('createAgentLoopHistoryPort delegates to the current transcript-backed history loader', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-history-'));
  const threadId = testThreadId(44);
  const port = createAgentLoopHistoryPort();

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'visible prompt',
    timestamp: '2026-03-30T00:00:00.000Z',
    metadata: {
      hiddenPrompt: 'canonical prompt',
    },
  });

  const history = await port.loadInitialHistory({
    workspaceRoot,
    threadId,
    prompt: 'canonical prompt',
  });

  assert.deepEqual(history, [{ kind: 'user', text: 'canonical prompt' }]);
});

void test('loadInitialHistory appends the current prompt when transcript tail does not match', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-history-'));
  const threadId = testThreadId(42);

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: 'previous answer',
    timestamp: '2026-03-30T00:00:01.000Z',
    metadata: {
      phase: 'final_answer',
    },
  });

  const history = await loadInitialHistory(
    workspaceRoot,
    threadId,
    'next prompt',
  );

  assert.deepEqual(history, [
    { kind: 'assistant', phase: 'final_answer', text: 'previous answer' },
    { kind: 'user', text: 'next prompt' },
  ]);
});

void test('loadInitialHistory rehydrates assistant artifact refs from the artifact store', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-history-'));
  const threadId = testThreadId(43);
  const committed = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run_43',
    renderer: 'markdown',
    payload: '# hello',
    digest: '요약',
    sourceRef: null,
    timestamp: '2026-04-10T00:00:00.000Z',
  });

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: '',
    timestamp: '2026-04-10T00:00:00.000Z',
    metadata: {
      phase: 'final_answer',
      artifactRefs: [committed.ref],
      activeArtifactRef: committed.ref,
    },
  });

  const history = await loadInitialHistory(
    workspaceRoot,
    threadId,
    'next prompt',
  );

  assert.deepEqual(history, [
    {
      kind: 'assistant',
      phase: 'final_answer',
      text: [
        '[Committed artifact]',
        `artifactRef: ${committed.ref.artifactId}@${committed.ref.version}`,
        'renderer: markdown',
        'digest: 요약',
        'payload:',
        '# hello',
      ].join('\n'),
    },
    { kind: 'user', text: 'next prompt' },
  ]);
});

void test('appendAssistantTextToHistory chooses commentary when function calls are pending', () => {
  const history: Array<{
    kind: 'assistant';
    phase: 'commentary' | 'final_answer';
    text: string;
  }> = [];

  appendAssistantTextToHistory(history, 'thinking...', [
    { id: 'fc-1', callId: 'call-1', name: 'read_file', arguments: '{}' },
  ]);

  assert.deepEqual(history, [
    { kind: 'assistant', phase: 'commentary', text: 'thinking...' },
  ]);
});

void test('appendAssistantTextToHistory chooses final_answer when no function calls are pending', () => {
  const history: Array<{
    kind: 'assistant';
    phase: 'commentary' | 'final_answer';
    text: string;
  }> = [];

  appendAssistantTextToHistory(history, 'final answer', []);
  appendAssistantTextToHistory(history, '', []);

  assert.deepEqual(history, [
    { kind: 'assistant', phase: 'final_answer', text: 'final answer' },
  ]);
});

void test('appendFunctionCallsToHistory appends canonical function_call entries', () => {
  const history: Array<{
    kind: 'function_call';
    id: string;
    callId: string;
    name: string;
    arguments: string;
  }> = [];
  const functionCalls: FunctionCall[] = [
    {
      id: 'fc-a',
      callId: 'call-a',
      name: 'search_files',
      arguments: '{"query":"hero"}',
    },
    {
      id: 'fc-b',
      callId: 'call-b',
      name: 'read_file',
      arguments: '{"path":"draft.md"}',
    },
  ];

  appendFunctionCallsToHistory(history, functionCalls);

  assert.deepEqual(history, [
    {
      kind: 'function_call',
      id: 'fc-a',
      callId: 'call-a',
      name: 'search_files',
      arguments: '{"query":"hero"}',
    },
    {
      kind: 'function_call',
      id: 'fc-b',
      callId: 'call-b',
      name: 'read_file',
      arguments: '{"path":"draft.md"}',
    },
  ]);
});

void test('appendInterjectToHistory appends a drained steer as a user turn', () => {
  const history: Array<{
    kind: 'user';
    text: string;
  }> = [];

  appendInterjectToHistory(history, {
    receivedSeq: 1,
    text: 'please account for this next',
  });

  assert.deepEqual(history, [
    { kind: 'user', text: 'please account for this next' },
  ]);
});

void test('persistSingleInterjectToTranscript writes one interject-tagged user entry', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-interject-history-'),
  );
  const threadId = testThreadId(44);

  await persistSingleInterjectToTranscript(workspaceRoot, threadId, {
    receivedSeq: 1,
    text: 'please revise the next step',
  });

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(entries.length, 1);
  assert.equal(typeof entries[0]?.entryId, 'string');
  assert.notEqual(entries[0]?.entryId, '');
  assert.deepEqual(entries[0], {
    entryId: entries[0]?.entryId,
    role: 'user',
    content: 'please revise the next step',
    timestamp: entries[0]?.timestamp,
    metadata: {
      source: 'interject',
    },
  });
  assert.equal(typeof entries[0]?.timestamp, 'string');
  assert.notEqual(entries[0]?.timestamp, '');
});
