import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitThreadArtifactUpdateVersion,
  commitThreadArtifactVersion,
  deleteThreadArtifact,
  deleteThreadArtifactUpdateVersion,
} from '../sessions/artifact-store.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
  replaceTranscriptEntries,
} from '../sessions/transcript-log.js';
import {
  loadThreadIndex,
  upsertThreadSummary,
} from '../sessions/threads-index.js';
import type { ResolvedExecuteForegroundRunDeps } from './execute-foreground-run-contracts.js';
import { persistRequiredForegroundInput } from './foreground-input-persistence.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

const FIXED_NOW = '2026-04-02T00:00:00.000Z';

function makeDeps(
  overrides: Partial<ResolvedExecuteForegroundRunDeps> = {},
): ResolvedExecuteForegroundRunDeps {
  return {
    appendTranscriptEntry,
    commitThreadArtifactVersion,
    commitThreadArtifactUpdateVersion,
    deleteThreadArtifact,
    deleteThreadArtifactUpdateVersion,
    readTranscriptEntries,
    replaceTranscriptEntries,
    loadThreadIndex,
    upsertThreadSummary,
    now: () => FIXED_NOW,
    onPostRunPersistenceError: () => {},
    ...overrides,
  };
}

void test('persistRequiredForegroundInput stores hidden prompt only when visible transcript prompt differs', async () => {
  const threadId = testThreadId(1101);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-input-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });

  await persistRequiredForegroundInput({
    agentInput: {
      prompt: 'model-only prompt with replay detail',
      runContext,
    },
    transcriptPrompt: 'Visible display title',
    deps: makeDeps(),
  });

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.role, 'user');
  assert.equal(transcript[0]?.content, 'Visible display title');
  assert.equal(transcript[0]?.timestamp, FIXED_NOW);
  assert.deepEqual(transcript[0]?.metadata, {
    hiddenPrompt: 'model-only prompt with replay detail',
  });

  const summaries = await loadThreadIndex(workspaceRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.threadId, threadId);
  assert.equal(summaries[0]?.title, 'Visible display title');
  assert.equal(summaries[0]?.messageCount, 1);
  assert.equal(summaries[0]?.lastUpdated, FIXED_NOW);
});

void test('persistRequiredForegroundInput leaves user metadata absent when prompt is not hidden', async () => {
  const threadId = testThreadId(1102);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-input-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });

  await persistRequiredForegroundInput({
    agentInput: {
      prompt: 'same visible prompt',
      runContext,
    },
    transcriptPrompt: 'same visible prompt',
    deps: makeDeps(),
  });

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(transcript.length, 1);
  assert.equal(Object.hasOwn(transcript[0] ?? {}, 'metadata'), false);
  assert.equal(transcript[0]?.metadata, undefined);
});

void test('persistRequiredForegroundInput stamps artifact_frame origin for attribution', async () => {
  const threadId = testThreadId(1104);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-input-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });

  await persistRequiredForegroundInput({
    agentInput: {
      prompt: 'artifact frame requested a tool',
      runContext,
    },
    transcriptPrompt: 'artifact frame requested a tool',
    promptOrigin: 'artifact_frame',
    deps: makeDeps(),
  });

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(transcript.length, 1);
  // silent와 달리 origin 턴은 보이는 턴 — 귀속 렌더용 마커만 각인된다
  assert.deepEqual(transcript[0]?.metadata, { origin: 'artifact_frame' });
});

void test('persistRequiredForegroundInput fails before summary upsert when transcript append fails', async () => {
  const threadId = testThreadId(1103);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-input-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });

  await assert.rejects(
    persistRequiredForegroundInput({
      agentInput: {
        prompt: 'model prompt',
        runContext,
      },
      transcriptPrompt: 'visible prompt',
      deps: makeDeps({
        appendTranscriptEntry: async () => {
          throw new Error('transcript append failed');
        },
      }),
    }),
    /transcript append failed/,
  );

  assert.deepEqual(await loadThreadIndex(workspaceRoot), []);
});

void test('persistRequiredForegroundInput stores attachments and records metadata refs', async () => {
  const threadId = testThreadId(1103);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-fg-input-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });

  await persistRequiredForegroundInput({
    agentInput: {
      prompt: '이 이미지 좀 봐줘',
      runContext,
      attachments: [
        {
          name: '증상.png',
          mimeType: 'image/png',
          kind: 'image',
          bytes: Buffer.from('hello'),
        },
      ],
    },
    transcriptPrompt: '이 이미지 좀 봐줘',
    deps: makeDeps(),
  });

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(entries.length, 1);
  const metadata = entries[0]?.metadata;
  assert.ok(metadata && 'attachments' in metadata && metadata.attachments);
  const record = metadata.attachments[0]!;
  assert.equal(record.name, '증상.png');
  assert.equal(record.mimeType, 'image/png');
  assert.equal(record.kind, 'image');
  assert.equal(record.byteLength, 5);

  // 스토어에서 바이트가 다시 읽힌다
  const { readRunAttachment } =
    await import('../sessions/run-attachment-store.js');
  const bytes = await readRunAttachment({
    workspaceRoot,
    threadId,
    attachmentId: record.attachmentId,
  });
  assert.equal(bytes?.toString('utf8'), 'hello');
});
