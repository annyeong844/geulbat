import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { branchThreadSession } from './branch-thread.js';
import {
  commitThreadArtifactVersion,
  loadAllThreadArtifactVersions,
} from './artifact-store.js';
import {
  readRunAttachment,
  writeRunAttachment,
} from './run-attachment-store.js';
import { loadThreadIndex, upsertThreadSummary } from './threads-index.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
  resetTranscriptEntryCacheForTests,
} from './transcript-log.js';
import { testThreadId } from '../../test-support/thread-id.js';

async function makeWorkspaceRoot(): Promise<string> {
  resetTranscriptEntryCacheForTests();
  return mkdtemp(join(tmpdir(), 'geulbat-branch-thread-'));
}

async function seedSourceThread(args: {
  workspaceRoot: string;
  threadIdNumber: number;
}) {
  const threadId = testThreadId(args.threadIdNumber);
  const entries = [
    {
      entryId: 'entry-user-1',
      role: 'user' as const,
      content: 'first question',
      timestamp: '2026-07-12T00:00:00.000Z',
    },
    {
      entryId: 'entry-assistant-1',
      role: 'assistant' as const,
      content: 'first answer',
      timestamp: '2026-07-12T00:00:01.000Z',
    },
    {
      entryId: 'entry-user-2',
      role: 'user' as const,
      content: 'second question',
      timestamp: '2026-07-12T00:00:02.000Z',
    },
    {
      entryId: 'entry-assistant-2',
      role: 'assistant' as const,
      content: 'second answer',
      timestamp: '2026-07-12T00:00:03.000Z',
    },
  ];
  for (const entry of entries) {
    await appendTranscriptEntry(args.workspaceRoot, threadId, entry);
  }
  return { threadId, entries };
}

void test('branchThreadSession copies the full transcript into a new indexed thread', async () => {
  const workspaceRoot = await makeWorkspaceRoot();
  const { threadId, entries } = await seedSourceThread({
    workspaceRoot,
    threadIdNumber: 2101,
  });
  await upsertThreadSummary(workspaceRoot, {
    threadId,
    title: '원본 대화',
    lastUpdated: '2026-07-12T00:00:03.000Z',
    messageCount: entries.length,
  });

  const branched = await branchThreadSession({
    workspaceRoot,
    sourceThreadId: threadId,
  });
  assert.equal(branched.ok, true);
  if (!branched.ok) {
    return;
  }
  assert.notEqual(branched.threadId, threadId);
  assert.equal(branched.copiedMessageCount, 4);

  const copied = await readTranscriptEntries(workspaceRoot, branched.threadId);
  assert.deepEqual(
    copied.map((entry) => entry.entryId),
    entries.map((entry) => entry.entryId),
  );
  // 원 스레드 불변
  assert.equal(
    (await readTranscriptEntries(workspaceRoot, threadId)).length,
    4,
  );

  const index = await loadThreadIndex(workspaceRoot);
  const branchedSummary = index.find(
    (summary) => summary.threadId === branched.threadId,
  );
  assert.equal(branchedSummary?.title, '원본 대화 (브랜치)');
  assert.equal(branchedSummary?.messageCount, 4);
});

void test('branchThreadSession cuts at upToEntryId inclusive', async () => {
  const workspaceRoot = await makeWorkspaceRoot();
  const { threadId } = await seedSourceThread({
    workspaceRoot,
    threadIdNumber: 2102,
  });

  const branched = await branchThreadSession({
    workspaceRoot,
    sourceThreadId: threadId,
    upToEntryId: 'entry-assistant-1',
  });
  assert.equal(branched.ok, true);
  if (!branched.ok) {
    return;
  }
  assert.equal(branched.copiedMessageCount, 2);
  const copied = await readTranscriptEntries(workspaceRoot, branched.threadId);
  assert.deepEqual(
    copied.map((entry) => entry.entryId),
    ['entry-user-1', 'entry-assistant-1'],
  );
});

void test('branchThreadSession copies only artifacts referenced by copied messages', async () => {
  const workspaceRoot = await makeWorkspaceRoot();
  const threadId = testThreadId(2103);
  const committed = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-branch-artifact',
    renderer: 'markdown',
    payload: '# kept artifact',
    digest: null,
    sourceRef: null,
    timestamp: '2026-07-12T00:00:00.000Z',
  });
  const laterCommitted = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-branch-artifact',
    renderer: 'markdown',
    payload: '# dropped artifact',
    digest: null,
    sourceRef: null,
    timestamp: '2026-07-12T00:00:02.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-1',
    role: 'user',
    content: 'make an artifact',
    timestamp: '2026-07-12T00:00:00.000Z',
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-assistant-1',
    role: 'assistant',
    content: 'artifact committed',
    timestamp: '2026-07-12T00:00:01.000Z',
    metadata: { phase: 'final_answer', artifactRefs: [committed.ref] },
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-assistant-2',
    role: 'assistant',
    content: 'later artifact',
    timestamp: '2026-07-12T00:00:03.000Z',
    metadata: { phase: 'final_answer', artifactRefs: [laterCommitted.ref] },
  });

  const branched = await branchThreadSession({
    workspaceRoot,
    sourceThreadId: threadId,
    upToEntryId: 'entry-assistant-1',
  });
  assert.equal(branched.ok, true);
  if (!branched.ok) {
    return;
  }

  const copiedArtifacts = await loadAllThreadArtifactVersions(
    workspaceRoot,
    branched.threadId,
  );
  assert.equal(copiedArtifacts.length, 1);
  // ref 보존 — 복사된 메시지 메타데이터의 artifactId가 그대로 유효
  assert.equal(copiedArtifacts[0]?.artifactId, committed.ref.artifactId);
  assert.equal(copiedArtifacts[0]?.payload, '# kept artifact');
});

void test('branchThreadSession copies attachment blobs referenced by copied user messages', async () => {
  const workspaceRoot = await makeWorkspaceRoot();
  const threadId = testThreadId(2104);
  const attachmentId = '00000000-0000-4000-8000-00000000aa01';
  await writeRunAttachment({
    workspaceRoot,
    threadId,
    attachmentId,
    bytes: Buffer.from('attachment-bytes'),
  });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    entryId: 'entry-user-1',
    role: 'user',
    content: 'see attachment',
    timestamp: '2026-07-12T00:00:00.000Z',
    metadata: {
      attachments: [
        {
          attachmentId,
          name: 'note.txt',
          mimeType: 'text/plain',
          kind: 'text',
          byteLength: 16,
        },
      ],
    },
  });

  const branched = await branchThreadSession({
    workspaceRoot,
    sourceThreadId: threadId,
  });
  assert.equal(branched.ok, true);
  if (!branched.ok) {
    return;
  }

  const copiedBytes = await readRunAttachment({
    workspaceRoot,
    threadId: branched.threadId,
    attachmentId,
  });
  assert.equal(copiedBytes?.toString('utf8'), 'attachment-bytes');
});

void test('branchThreadSession rejects unknown threads and unknown cut entries', async () => {
  const workspaceRoot = await makeWorkspaceRoot();

  const missingThread = await branchThreadSession({
    workspaceRoot,
    sourceThreadId: testThreadId(2105),
  });
  assert.equal(missingThread.ok, false);

  const { threadId } = await seedSourceThread({
    workspaceRoot,
    threadIdNumber: 2106,
  });
  const missingEntry = await branchThreadSession({
    workspaceRoot,
    sourceThreadId: threadId,
    upToEntryId: 'entry-missing',
  });
  assert.equal(missingEntry.ok, false);
});
