import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  appendTranscriptEntry,
  getTranscriptEntryCacheLimitForTests,
  getTranscriptEntryCacheSizeForTests,
  getTranscriptEntryParseCountForTests,
  hasTranscriptEntryCacheForTests,
  readTranscriptEntries,
  replaceTranscriptEntries,
  resetTranscriptEntryCacheForTests,
} from './transcript-log.js';

void test('readTranscriptEntries rejects malformed JSONL lines', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(1);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const threadPath = join(sessionsDir, `${threadId}.jsonl`);
  await writeFile(
    threadPath,
    [
      JSON.stringify({
        role: 'user',
        content: 'hello',
        timestamp: '2026-03-22T00:00:00.000Z',
      }),
      '{bad json',
      JSON.stringify({
        role: 'assistant',
        content: 'world',
        timestamp: '2026-03-22T00:00:01.000Z',
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  await assert.rejects(
    () => readTranscriptEntries(workspaceRoot, threadId),
    (error: unknown) => {
      assert.equal(
        (error as { name?: unknown }).name,
        'TranscriptCorruptionError',
      );
      assert.equal((error as { code?: unknown }).code, 'transcript_corrupt');
      assert.equal((error as { threadId?: unknown }).threadId, threadId);
      assert.equal((error as { lineNumber?: unknown }).lineNumber, 2);
      assert.match(String((error as { message?: unknown }).message), /line 2/);
      return true;
    },
  );
});

void test('readTranscriptEntries preserves assistant metadata for artifact reconstruction', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(2);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const threadPath = join(sessionsDir, `${threadId}.jsonl`);
  await writeFile(
    threadPath,
    [
      JSON.stringify({
        role: 'assistant',
        content:
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"요약"} -->\n# hello\n<!-- /GEULBAT_ARTIFACT -->',
        timestamp: '2026-03-25T00:00:00.000Z',
        metadata: {
          phase: 'final_answer',
          sourceFile: 'episodes/ch01.md',
          sourceRunId: 'run-1',
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.metadata, {
    phase: 'final_answer',
    sourceFile: 'episodes/ch01.md',
    sourceRunId: 'run-1',
  });
});

void test('readTranscriptEntries rejects transcript entries with malformed metadata', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(3);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const threadPath = join(sessionsDir, `${threadId}.jsonl`);
  await writeFile(
    threadPath,
    [
      JSON.stringify({
        role: 'assistant',
        content: 'valid',
        timestamp: '2026-03-26T00:00:00.000Z',
        metadata: { phase: 'commentary' },
      }),
      JSON.stringify({
        role: 'assistant',
        content: 'invalid',
        timestamp: '2026-03-26T00:00:01.000Z',
        metadata: 'bad-metadata',
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  await assert.rejects(
    () => readTranscriptEntries(workspaceRoot, threadId),
    (error: unknown) => {
      assert.equal(
        (error as { name?: unknown }).name,
        'TranscriptCorruptionError',
      );
      assert.equal((error as { code?: unknown }).code, 'transcript_corrupt');
      assert.equal((error as { threadId?: unknown }).threadId, threadId);
      assert.equal((error as { lineNumber?: unknown }).lineNumber, 2);
      return true;
    },
  );
});

void test('appendTranscriptEntry serializes concurrent appends for the same thread', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(4);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const entries = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `entry-${index}-` + 'x'.repeat(4096),
    timestamp: `2026-03-27T00:00:${String(index).padStart(2, '0')}.000Z`,
  })) satisfies Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;

  await Promise.all(
    entries.map((entry) =>
      appendTranscriptEntry(workspaceRoot, threadId, entry),
    ),
  );

  const persisted = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(persisted.length, entries.length);
  assert.deepEqual(
    persisted.map((entry) => entry.content),
    entries.map((entry) => entry.content),
  );
});

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

  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'assistant',
    content: 'second',
    timestamp: '2026-03-29T00:00:01.000Z',
  });

  const updated = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    updated.map((entry) => entry.content),
    ['first', 'second'],
  );
  assert.equal(getTranscriptEntryParseCountForTests(), 1);
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
  assert.deepEqual(rewritten, [
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
