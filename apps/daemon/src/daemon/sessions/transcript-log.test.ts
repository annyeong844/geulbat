import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  appendTranscriptEntry,
  appendTranscriptEntryOnce,
  CompareAndAppendMismatchError,
  readTranscriptEntries,
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
  assert.equal(
    persisted.every((entry) => entry.entryId.trim() !== ''),
    true,
  );
});

void test('appendTranscriptEntry assigns and persists entry ids', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(17);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));

  const appended = await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'hello',
    timestamp: '2026-03-27T01:00:00.000Z',
  });

  assert.equal(appended.entryId.trim() !== '', true);

  const raw = await readFile(
    join(workspaceRoot, '.geulbat', 'sessions', `${threadId}.jsonl`),
    'utf8',
  );
  const persisted = JSON.parse(raw.trim()) as { entryId?: unknown };
  assert.equal(persisted.entryId, appended.entryId);

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.equal(entries[0]?.entryId, appended.entryId);
});

void test('appendTranscriptEntryOnce deduplicates one prepared identity and rejects conflicting content', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(25);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const prepared = {
    entryId: 'prepared-child-input',
    role: 'user' as const,
    content: 'deliver once',
    timestamp: '2026-07-29T00:00:00.000Z',
  };

  const [first, second] = await Promise.all([
    appendTranscriptEntryOnce(workspaceRoot, threadId, prepared),
    appendTranscriptEntryOnce(workspaceRoot, threadId, prepared),
  ]);

  assert.deepEqual(second, first);
  assert.deepEqual(await readTranscriptEntries(workspaceRoot, threadId), [
    prepared,
  ]);
  await assert.rejects(
    appendTranscriptEntryOnce(workspaceRoot, threadId, {
      ...prepared,
      content: 'conflicting delivery',
    }),
    /transcript entry identity conflicts: prepared-child-input/,
  );
  assert.deepEqual(await readTranscriptEntries(workspaceRoot, threadId), [
    prepared,
  ]);
});

void test('readTranscriptEntries assigns stable virtual entry ids to legacy entries', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(18);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const sessionsDir = join(workspaceRoot, '.geulbat', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `${threadId}.jsonl`),
    JSON.stringify({
      role: 'assistant',
      content: 'legacy-entry',
      timestamp: '2026-03-27T01:01:00.000Z',
    }) + '\n',
    'utf8',
  );

  const firstRead = await readTranscriptEntries(workspaceRoot, threadId);
  resetTranscriptEntryCacheForTests();
  const secondRead = await readTranscriptEntries(workspaceRoot, threadId);

  assert.equal(firstRead.length, 1);
  assert.equal(secondRead.length, 1);
  assert.equal(firstRead[0]?.entryId, secondRead[0]?.entryId);
  assert.match(firstRead[0]?.entryId ?? '', new RegExp(`^${threadId}:1:`));
  assert.equal(firstRead[0]?.entryId, `${threadId}:1:522190a510198fb3`);
});

void test('appendTranscriptEntry rejects stale compare-and-append expectations', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(19);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const first = await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'first',
    timestamp: '2026-03-27T01:02:00.000Z',
  });

  await assert.rejects(
    () =>
      appendTranscriptEntry(
        workspaceRoot,
        threadId,
        {
          role: 'assistant',
          content: 'stale',
          timestamp: '2026-03-27T01:02:01.000Z',
        },
        { expectedLastEntryId: 'not-the-current-entry' },
      ),
    (error: unknown) => {
      assert.equal(error instanceof CompareAndAppendMismatchError, true);
      assert.equal(
        (error as CompareAndAppendMismatchError).actualLastEntryId,
        first.entryId,
      );
      return true;
    },
  );

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    entries.map((entry) => entry.content),
    ['first'],
  );
});

void test('appendTranscriptEntry accepts matching compare-and-append expectations', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(20);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const first = await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: 'first',
    timestamp: '2026-03-27T01:03:00.000Z',
  });

  await appendTranscriptEntry(
    workspaceRoot,
    threadId,
    {
      role: 'assistant',
      content: 'second',
      timestamp: '2026-03-27T01:03:01.000Z',
    },
    { expectedLastEntryId: first.entryId },
  );

  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    entries.map((entry) => entry.content),
    ['first', 'second'],
  );
});
