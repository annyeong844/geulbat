import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  allocateMemoryNoteFileName,
  appendMemoryNote,
  archiveConsolidatedMemoryNotes,
  listPendingMemoryNotes,
  memoryConsolidationIsDue,
  readLegacyMemorySummary,
  removeLegacyMemorySummary,
  resolveCurrentMemoryNotesDirectory,
  resolveHistoricalMemoryNotesDirectory,
  resolveMemorySummaryPath,
} from './notes-store.js';

async function makeStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-memories-'));
}

void test('a written note is pending until it is archived', async () => {
  const stateRoot = await makeStateRoot();

  const written = await appendMemoryNote(stateRoot, '수연은 존댓말을 쓴다');

  assert.equal(
    written.path.startsWith(resolveCurrentMemoryNotesDirectory(stateRoot)),
    true,
  );
  assert.equal(await readFile(written.path, 'utf8'), '수연은 존댓말을 쓴다\n');
  const pending = await listPendingMemoryNotes(stateRoot);
  assert.deepEqual(
    pending.map((note) => note.text),
    ['수연은 존댓말을 쓴다'],
  );

  const archived = await archiveConsolidatedMemoryNotes(stateRoot, pending);

  assert.deepEqual(archived, { archivedCount: 1 });
  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
  assert.equal(
    await readFile(
      join(
        resolveHistoricalMemoryNotesDirectory(stateRoot),
        pending[0]!.fileName,
      ),
      'utf8',
    ),
    '수연은 존댓말을 쓴다\n',
  );
});

void test('a prepared note identity survives replay and archival without duplication', async () => {
  const stateRoot = await makeStateRoot();
  const preparedFileName = allocateMemoryNoteFileName();
  const first = await appendMemoryNote(stateRoot, '한 번만 남는 노트', {
    preparedFileName,
  });
  const replay = await appendMemoryNote(stateRoot, '한 번만 남는 노트', {
    preparedFileName,
  });

  assert.deepEqual(replay, first);
  const pending = await listPendingMemoryNotes(stateRoot);
  assert.equal(pending.length, 1);
  await archiveConsolidatedMemoryNotes(stateRoot, pending);

  const replayAfterArchive = await appendMemoryNote(
    stateRoot,
    '한 번만 남는 노트',
    { preparedFileName },
  );
  assert.equal(
    replayAfterArchive.path,
    join(resolveHistoricalMemoryNotesDirectory(stateRoot), preparedFileName),
  );
  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
  await assert.rejects(
    async () =>
      await appendMemoryNote(stateRoot, '같은 좌표의 다른 내용', {
        preparedFileName,
      }),
    (error: unknown) =>
      (error as { code?: unknown }).code === 'persistence_unavailable',
  );
});

void test('notes written in one wall-clock tick retain invocation order', async (t) => {
  const stateRoot = await makeStateRoot();
  const fixedTimestampMs = Date.UTC(9999, 0, 1);
  t.mock.method(Date, 'now', () => fixedTimestampMs);

  const [first, second] = await Promise.all([
    appendMemoryNote(stateRoot, '첫 노트'),
    appendMemoryNote(stateRoot, '둘째 노트'),
  ]);

  assert.notEqual(first.path, second.path);
  assert.deepEqual(
    [first, second].map(({ path }) => basename(path).slice(0, 24)),
    ['9999-01-01T00-00-00.000Z', '9999-01-01T00-00-00.001Z'],
  );
  assert.deepEqual(
    (await listPendingMemoryNotes(stateRoot)).map((note) => note.text),
    ['첫 노트', '둘째 노트'],
  );
});

void test('the pending listing does not grow with archived notes', async () => {
  const stateRoot = await makeStateRoot();
  const historical = resolveHistoricalMemoryNotesDirectory(stateRoot);
  await mkdir(historical, { recursive: true });
  for (let index = 0; index < 50; index += 1) {
    await writeFile(
      join(
        historical,
        `1999-01-01T00-00-${String(index).padStart(2, '0')}-000Z-aaaaaaaa.md`,
      ),
      `archived ${index}`,
      'utf8',
    );
  }
  await appendMemoryNote(stateRoot, 'the only pending note');

  const pending = await listPendingMemoryNotes(stateRoot);

  assert.deepEqual(
    pending.map((note) => note.text),
    ['the only pending note'],
  );
  assert.equal((await readdir(historical)).length, 50);
});

void test('notes written before the split stay visible and are archived on the next pass', async () => {
  const stateRoot = await makeStateRoot();
  const legacyDirectory = join(stateRoot, 'memories', 'notes');
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    join(legacyDirectory, '1999-01-01T00-00-01-000Z-aaaaaaaa.md'),
    'written before the split',
    'utf8',
  );
  await writeFile(
    join(stateRoot, 'memories', 'state.json'),
    '{"version":1,"consolidatedThroughNoteFileName":"whatever.md"}',
    'utf8',
  );
  await appendMemoryNote(stateRoot, 'written after the split');

  const pending = await listPendingMemoryNotes(stateRoot);
  assert.deepEqual(
    pending.map((note) => note.text),
    ['written before the split', 'written after the split'],
  );

  await archiveConsolidatedMemoryNotes(stateRoot, pending);

  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
  assert.equal(
    (await readdir(resolveHistoricalMemoryNotesDirectory(stateRoot))).length,
    2,
  );
  await assert.rejects(
    async () =>
      await readFile(join(stateRoot, 'memories', 'state.json'), 'utf8'),
  );
});

void test('an empty note is refused instead of creating a blank file', async () => {
  const stateRoot = await makeStateRoot();

  await assert.rejects(
    async () => await appendMemoryNote(stateRoot, '   \n\n'),
    (error: unknown) => (error as { code?: unknown }).code === 'invalid_args',
  );
  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
});

void test('a note that cannot be archived stays pending instead of vanishing', async () => {
  const stateRoot = await makeStateRoot();
  const pending = [
    {
      fileName: 'never-existed.md',
      path: join(
        resolveCurrentMemoryNotesDirectory(stateRoot),
        'never-existed.md',
      ),
      text: 'not on disk',
    },
  ];

  const archived = await archiveConsolidatedMemoryNotes(stateRoot, pending);

  assert.deepEqual(archived, { archivedCount: 0 });
});

void test('a legacy summary is readable once and removable after it is absorbed', async () => {
  const stateRoot = await makeStateRoot();
  await appendMemoryNote(stateRoot, 'creates the memories root');
  await writeFile(
    resolveMemorySummaryPath(stateRoot),
    '## 사용자\n존댓말을 쓴다\n',
    'utf8',
  );

  assert.equal(
    await readLegacyMemorySummary(stateRoot),
    '## 사용자\n존댓말을 쓴다',
  );

  await removeLegacyMemorySummary(stateRoot);

  assert.equal(await readLegacyMemorySummary(stateRoot), undefined);
});

void test('an empty state root has no pending notes and no legacy summary', async () => {
  const stateRoot = await makeStateRoot();
  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
  assert.equal(await readLegacyMemorySummary(stateRoot), undefined);
});

void test('consolidation is due only once enough notes have accumulated', () => {
  assert.equal(memoryConsolidationIsDue(0), false);
  assert.equal(memoryConsolidationIsDue(9), false);
  assert.equal(memoryConsolidationIsDue(10), true);
  assert.equal(memoryConsolidationIsDue(11), true);
});
