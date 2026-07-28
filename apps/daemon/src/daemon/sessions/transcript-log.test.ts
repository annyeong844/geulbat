import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import {
  buildHostCommandOutputRef,
  buildHostCommandPaths,
} from '../host-command-output-store.js';
import {
  appendTranscriptEntries,
  appendTranscriptEntry,
  appendTranscriptEntryOnce,
  CompareAndAppendMismatchError,
  getTranscriptEntryCacheLimitForTests,
  getTranscriptEntryCacheSizeForTests,
  getTranscriptEntryParseCountForTests,
  hasTranscriptEntryCacheForTests,
  readLastTranscriptEntryId,
  readTranscriptEntries,
  replaceTranscriptEntries,
  resetTranscriptEntryCacheForTests,
  rewriteTranscriptDurableOutputRefs,
} from './transcript-log.js';

void test('rewriteTranscriptDurableOutputRefs changes only structured result and compaction refs', () => {
  const sourceRef = 'tool-output:00000000-0000-4000-8000-000000000001/run/call';
  const targetRef = 'tool-output:00000000-0000-4000-8000-000000000002/run/call';
  const rewritten = rewriteTranscriptDurableOutputRefs(
    [
      {
        entryId: 'entry-user-ref-text',
        role: 'user',
        content: `do not rewrite this quoted text: ${sourceRef}`,
        timestamp: '2026-07-27T00:00:00.000Z',
      },
      {
        entryId: 'entry-tool-ref',
        role: 'tool_result',
        content: JSON.stringify({
          output: JSON.stringify({
            outputRef: sourceRef,
            snapshot: { outputRef: sourceRef },
          }),
        }),
        timestamp: '2026-07-27T00:00:01.000Z',
      },
      {
        entryId: 'entry-compaction-ref',
        role: 'compaction',
        content: '',
        timestamp: '2026-07-27T00:00:02.000Z',
        compactionData: {
          kind: 'provider_native',
          providerId: 'openai_codex_direct',
          model: 'gpt-fixture',
          output: [{ type: 'compaction_summary', text: 'summary' }],
          tokensBefore: 100,
          contextWindow: 1_000,
          thresholdTokens: 900,
          evidence: [
            {
              callId: 'call',
              toolName: 'search_files',
              outcome: 'success',
              fullOutputBytes: 10,
              outputRef: sourceRef,
            },
          ],
          expandedEvidencePages: [
            { outputRef: sourceRef, offset: 0, endOffset: 10, totalChars: 10 },
          ],
        },
      },
    ],
    new Map([[sourceRef, targetRef]]),
  );

  assert.match(rewritten[0]?.content ?? '', new RegExp(sourceRef));
  assert.doesNotMatch(rewritten[1]?.content ?? '', new RegExp(sourceRef));
  assert.match(rewritten[1]?.content ?? '', new RegExp(targetRef));
  const compaction = rewritten[2];
  assert.equal(compaction?.role, 'compaction');
  if (
    compaction?.role === 'compaction' &&
    'kind' in compaction.compactionData &&
    compaction.compactionData.kind === 'provider_native'
  ) {
    assert.equal(compaction.compactionData.evidence?.[0]?.outputRef, targetRef);
    assert.equal(
      compaction.compactionData.expandedEvidencePages?.[0]?.outputRef,
      targetRef,
    );
  }
});

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

void test('replaceTranscriptEntries prunes durable outputs whose refs leave the authoritative transcript', async () => {
  resetTranscriptEntryCacheForTests();
  const threadId = testThreadId(9);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-transcript-'));
  const retainedOutputRef = buildToolOutputRef({
    threadId,
    runId: 'run-retained',
    callId: 'call-retained',
  });
  const removedOutputRef = buildToolOutputRef({
    threadId,
    runId: 'run-removed',
    callId: 'call-removed',
  });
  const retainedCommandOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000301',
  });
  const removedCommandOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000302',
  });
  const checkpointCommandOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000303',
  });
  for (const [outputRef, runId, callId] of [
    [retainedOutputRef, 'run-retained', 'call-retained'],
    [removedOutputRef, 'run-removed', 'call-removed'],
  ] as const) {
    await writeToolOutputSnapshot({
      stateRoot: workspaceRoot,
      snapshot: buildToolOutputSnapshot({
        outputRef,
        threadId,
        runId,
        callId,
        toolName: 'exec_command',
        output: JSON.stringify({ stdout: `${callId} output` }),
      }),
    });
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId,
        tool: 'exec_command',
        ok: true,
        output: JSON.stringify({
          offloaded: true,
          outputRef,
          recoveryTool: 'read_tool_output',
        }),
      }),
      timestamp: '2026-03-31T00:00:00.000Z',
    });
  }
  const retainedCommandPaths = buildHostCommandPaths({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: retainedCommandOutputRef,
  });
  const removedCommandPaths = buildHostCommandPaths({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: removedCommandOutputRef,
  });
  const checkpointCommandPaths = buildHostCommandPaths({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: checkpointCommandOutputRef,
  });
  for (const paths of [
    retainedCommandPaths,
    removedCommandPaths,
    checkpointCommandPaths,
  ]) {
    await mkdir(paths.directory, { recursive: true });
    await Promise.all([
      writeFile(paths.stdout, 'command output', 'utf8'),
      writeFile(paths.stderr, '', 'utf8'),
    ]);
  }
  await appendTranscriptEntries(workspaceRoot, threadId, [
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-command-retained',
        tool: 'write_stdin',
        ok: true,
        output: JSON.stringify({
          snapshot: { outputRef: retainedCommandOutputRef, status: 'exit' },
          page: null,
        }),
      }),
      timestamp: '2026-03-31T00:00:01.000Z',
    },
    {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-command-removed',
        tool: 'exec_command',
        ok: true,
        output: JSON.stringify({
          outputRef: removedCommandOutputRef,
          status: 'exit',
        }),
      }),
      timestamp: '2026-03-31T00:00:02.000Z',
    },
  ]);

  const currentEntries = await readTranscriptEntries(workspaceRoot, threadId);
  await replaceTranscriptEntries(workspaceRoot, threadId, [
    ...currentEntries.filter(
      (entry) =>
        !entry.content.includes(removedOutputRef) &&
        !entry.content.includes(removedCommandOutputRef),
    ),
    {
      role: 'compaction',
      content: '',
      timestamp: '2026-03-31T00:00:03.000Z',
      compactionData: {
        kind: 'provider_native',
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        output: [{ type: 'compaction_summary', encrypted_content: 'opaque' }],
        tokensBefore: 100,
        contextWindow: 1_000,
        thresholdTokens: 900,
        evidence: [
          {
            callId: 'call-command-checkpoint',
            toolName: 'exec_command',
            outcome: 'success',
            fullOutputBytes: 14,
            outputRef: checkpointCommandOutputRef,
          },
        ],
      },
    },
  ]);

  assert.equal(
    (
      await readToolOutputSnapshot({
        stateRoot: workspaceRoot,
        threadId,
        outputRef: retainedOutputRef,
      })
    ).ok,
    true,
  );
  const removed = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: removedOutputRef,
  });
  assert.equal(removed.ok, false);
  if (removed.ok) {
    throw new Error('expected removed snapshot to be pruned');
  }
  assert.equal(removed.errorCode, 'not_found');
  assert.equal(
    (await stat(retainedCommandPaths.directory)).isDirectory(),
    true,
  );
  assert.equal(
    (await stat(checkpointCommandPaths.directory)).isDirectory(),
    true,
  );
  await assert.rejects(
    stat(removedCommandPaths.directory),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
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
