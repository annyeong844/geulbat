import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  appendTranscriptEntries,
  appendTranscriptEntry,
  getTranscriptEntryCacheLimitForTests,
  getTranscriptEntryCacheSizeForTests,
  getTranscriptEntryParseCountForTests,
  hasTranscriptEntryCacheForTests,
  readLastTranscriptEntryId,
  readTranscriptEntries,
  replaceTranscriptEntries,
  resetTranscriptEntryCacheForTests,
} from './transcript-log.js';

void test('readTranscriptEntries reuses the cached parse while the transcript snapshot is unchanged', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(5);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const threadPath = join(sessionsDir, `${threadId}.jsonl`);
  await writeFile(
    threadPath,
    JSON.stringify({
      role: 'user',
      content: 'hello',
      timestamp: '2026-03-28T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );

  const firstRead = await readTranscriptEntries(workspaceRoot, threadId);
  const secondRead = await readTranscriptEntries(workspaceRoot, threadId);

  assert.equal(firstRead.length, 1);
  assert.deepEqual(secondRead, firstRead);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);
});

void test('appendTranscriptEntry updates a warmed transcript cache without forcing a full reparse', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(6);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'first',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  const initial = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(initial.length, 1);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  const appended = await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: 'second',
    timestamp: '2026-03-29T00:00:01.000Z',
  });

  assert.equal(
    await readLastTranscriptEntryId(workspaceRoot, threadId),
    appended.entryId,
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  const updated = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    updated.map((entry) => entry.content),
    ['first', 'second'],
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 1);
});

void test('appendTranscriptEntry recreates a removed directory behind a warmed cache', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(22);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'before-directory-removal',
    timestamp: '2026-03-29T00:05:00.000Z',
  });
  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  await rm(sessionsDir, { recursive: true, force: true });
  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: 'after-directory-removal',
    timestamp: '2026-03-29T00:05:01.000Z',
  });

  const updated = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    updated.map((entry) => entry.content),
    ['after-directory-removal'],
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 2);
});

void test('appendTranscriptEntries persists an ordered batch and updates a warmed cache once', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(21);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'before-batch',
    timestamp: '2026-03-29T00:10:00.000Z',
  });
  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  const appended = await appendTranscriptEntries(workspaceRoot, threadId, [
    {
      role: 'tool_call',
      content: '{"callId":"call-a"}',
      timestamp: '2026-03-29T00:10:01.000Z',
    },
    {
      role: 'tool_call',
      content: '{"callId":"call-b"}',
      timestamp: '2026-03-29T00:10:02.000Z',
    },
  ]);

  const updated = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    updated.map((entry) => entry.content),
    ['before-batch', '{"callId":"call-a"}', '{"callId":"call-b"}'],
  );
  assert.deepEqual(
    appended.map((entry) => entry.entryId),
    updated.slice(1).map((entry) => entry.entryId),
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 1);
});

void test('appendTranscriptEntry invalidates a warmed cache after an external transcript rewrite', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(16);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const threadPath = join(sessionsDir, `${threadId}.jsonl`);
  await writeFile(
    threadPath,
    JSON.stringify({
      role: 'user',
      content: 'stale-cache-source',
      timestamp: '2026-03-29T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );

  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  await writeFile(
    threadPath,
    [
      JSON.stringify({
        role: 'assistant',
        content: 'external-rewrite-first-entry-with-different-size',
        timestamp: '2026-03-29T00:01:00.000Z',
      }),
      JSON.stringify({
        role: 'user',
        content: 'external-rewrite-second-entry',
        timestamp: '2026-03-29T00:01:01.000Z',
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: 'appended-after-external-rewrite',
    timestamp: '2026-03-29T00:01:02.000Z',
  });

  const updated = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    updated.map((entry) => entry.content),
    [
      'external-rewrite-first-entry-with-different-size',
      'external-rewrite-second-entry',
      'appended-after-external-rewrite',
    ],
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 2);
});

void test('readTranscriptEntries invalidates the cache after an external transcript rewrite', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(7);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const threadPath = join(sessionsDir, `${threadId}.jsonl`);
  await writeFile(
    threadPath,
    JSON.stringify({
      role: 'user',
      content: 'first',
      timestamp: '2026-03-30T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );

  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  await writeFile(
    threadPath,
    JSON.stringify({
      role: 'assistant',
      content: 'rewritten',
      timestamp: '2026-03-30T00:00:01.000Z',
    }) + '\n',
    'utf8',
  );

  const rewritten = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    rewritten.map((entry) => entry.content),
    ['rewritten'],
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 2);
});

void test('replaceTranscriptEntries rewrites the transcript and refreshes the warmed cache', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(8);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'first',
    timestamp: '2026-03-31T00:00:00.000Z',
  });
  await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(getTranscriptEntryParseCountForTests(), 1);

  await replaceTranscriptEntries(workspaceRoot, threadId, [
    {
      role: 'assistant',
      content: 'rewritten',
      timestamp: '2026-03-31T00:00:01.000Z',
      metadata: {
        phase: 'final_answer',
        artifactRefs: [{ artifactId: 'art_rewritten', version: 1 }],
        activeArtifactRef: { artifactId: 'art_rewritten', version: 1 },
      },
    },
  ]);

  const rewritten = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(rewritten.length, 1);
  assert.equal(rewritten[0]?.entryId.trim() !== '', true);
  assert.deepEqual(
    rewritten.map(({ entryId: _entryId, ...entry }) => entry),
    [
      {
        role: 'assistant',
        content: 'rewritten',
        timestamp: '2026-03-31T00:00:01.000Z',
        metadata: {
          phase: 'final_answer',
          artifactRefs: [{ artifactId: 'art_rewritten', version: 1 }],
          activeArtifactRef: { artifactId: 'art_rewritten', version: 1 },
        },
      },
    ],
  );
  assert.equal(
    getTranscriptEntryParseCountForTests(),
    1,
    'cache should stay warm after replaceTranscriptEntries',
  );
});

void test('readTranscriptEntries bounds the transcript cache and evicts the least recently used thread', async () => {
  resetTranscriptEntryCacheForTests();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const cacheLimit = getTranscriptEntryCacheLimitForTests();
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  for (let index = 0; index < cacheLimit; index += 1) {
    const threadId = testThreadId(1000 + index);
    await writeFile(
      join(sessionsDir, `${threadId}.jsonl`),
      JSON.stringify({
        role: 'user',
        content: `entry-${index}`,
        timestamp: `2026-04-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }) + '\n',
      'utf8',
    );
    await readTranscriptEntries(workspaceRoot, threadId);
  }

  const warmedThreadId = testThreadId(1000);
  const evictedThreadId = testThreadId(1001);
  await readTranscriptEntries(workspaceRoot, warmedThreadId);

  const overflowThreadId = testThreadId(1000 + cacheLimit);
  await writeFile(
    join(sessionsDir, `${overflowThreadId}.jsonl`),
    JSON.stringify({
      role: 'assistant',
      content: 'overflow',
      timestamp: '2026-04-01T01:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  await readTranscriptEntries(workspaceRoot, overflowThreadId);

  assert.equal(getTranscriptEntryCacheSizeForTests(), cacheLimit);
  assert.equal(
    hasTranscriptEntryCacheForTests(workspaceRoot, warmedThreadId),
    true,
  );
  assert.equal(
    hasTranscriptEntryCacheForTests(workspaceRoot, evictedThreadId),
    false,
  );
  assert.equal(
    hasTranscriptEntryCacheForTests(workspaceRoot, overflowThreadId),
    true,
  );
});
