import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitMemoryEntries,
  readMemoryEntries,
  recordMemoryEntryUsage,
  resolveMemoryEntriesDirectory,
} from './entries-store.js';

async function makeStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-entries-'));
}

void test('committed entries get addresses and read back unused', async () => {
  const stateRoot = await makeStateRoot();

  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: '수연은 존댓말을 쓴다' },
    { id: undefined, text: '이 저장소의 lint는 샤딩되어 있다' },
  ]);

  assert.equal(entryIds.length, 2);
  for (const entryId of entryIds) {
    assert.match(entryId, /^m-[0-9a-f]{8}$/u);
  }
  const entries = await readMemoryEntries(stateRoot);
  assert.deepEqual(
    entries.map((entry) => entry.usageCount),
    [0, 0],
  );
  assert.deepEqual(
    [...entries.map((entry) => entry.text)].sort(),
    ['수연은 존댓말을 쓴다', '이 저장소의 lint는 샤딩되어 있다'].sort(),
  );
});

void test('citing an entry is measured and survives a rewrite that keeps its address', async () => {
  const stateRoot = await makeStateRoot();
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'original wording' },
  ]);
  const entryId = entryIds[0]!;

  await recordMemoryEntryUsage(stateRoot, [entryId]);
  await recordMemoryEntryUsage(stateRoot, [entryId]);

  const beforeRewrite = await readMemoryEntries(stateRoot);
  assert.equal(beforeRewrite[0]?.usageCount, 2);
  assert.notEqual(beforeRewrite[0]?.lastUsedAt, undefined);

  await commitMemoryEntries(stateRoot, [{ id: entryId, text: 'new wording' }]);

  const afterRewrite = await readMemoryEntries(stateRoot);
  assert.equal(afterRewrite[0]?.id, entryId);
  assert.equal(afterRewrite[0]?.text, 'new wording');
  assert.equal(afterRewrite[0]?.usageCount, 2);
});

void test('an entry dropped by consolidation loses its file and its measurement', async () => {
  const stateRoot = await makeStateRoot();
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'keep me' },
    { id: undefined, text: 'drop me' },
  ]);
  const entries = await readMemoryEntries(stateRoot);
  const dropped = entries.find((entry) => entry.text === 'drop me')!;
  const kept = entries.find((entry) => entry.text === 'keep me')!;
  await recordMemoryEntryUsage(stateRoot, [dropped.id, kept.id]);

  await commitMemoryEntries(stateRoot, [{ id: kept.id, text: 'keep me' }]);

  const remaining = await readMemoryEntries(stateRoot);
  assert.deepEqual(
    remaining.map((entry) => entry.id),
    [kept.id],
  );
  assert.equal(remaining[0]?.usageCount, 1);
  const usageLog = await readFile(
    join(stateRoot, 'memories', 'usage.jsonl'),
    'utf8',
  );
  assert.equal(usageLog.includes(dropped.id), false);
  assert.equal(entryIds.length, 2);
});

void test('citing an unknown address is reported instead of inventing history', async () => {
  const stateRoot = await makeStateRoot();
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'real entry' },
  ]);

  const outcome = await recordMemoryEntryUsage(stateRoot, [
    entryIds[0]!,
    'm-deadbeef',
  ]);

  assert.deepEqual(outcome.recorded, [entryIds[0]]);
  assert.deepEqual(outcome.unknown, ['m-deadbeef']);
  assert.equal((await readMemoryEntries(stateRoot))[0]?.usageCount, 1);
});

void test('an empty entry set is refused so consolidation cannot erase memory', async () => {
  const stateRoot = await makeStateRoot();
  await commitMemoryEntries(stateRoot, [{ id: undefined, text: 'keep me' }]);

  await assert.rejects(
    async () =>
      await commitMemoryEntries(stateRoot, [{ id: undefined, text: '  \n' }]),
    (error: unknown) => (error as { code?: unknown }).code === 'invalid_args',
  );
  assert.equal((await readMemoryEntries(stateRoot)).length, 1);
});

void test('a corrupt usage line is skipped without losing the rest of the measurement', async () => {
  const stateRoot = await makeStateRoot();
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'measured entry' },
  ]);
  const entryId = entryIds[0]!;
  await recordMemoryEntryUsage(stateRoot, [entryId]);
  await writeFile(
    join(stateRoot, 'memories', 'usage.jsonl'),
    `{"entryId":"${entryId}","at":"1999-01-01T00:00:00.000Z"}\ntruncated{\n{"entryId":"${entryId}","at":"1999-01-02T00:00:00.000Z"}\n`,
    'utf8',
  );

  const entries = await readMemoryEntries(stateRoot);

  assert.equal(entries[0]?.usageCount, 2);
  assert.equal(entries[0]?.lastUsedAt, '1999-01-02T00:00:00.000Z');
});

void test('an unreadable entries directory carries no memory', async () => {
  const stateRoot = await makeStateRoot();
  assert.deepEqual(await readMemoryEntries(stateRoot), []);
  assert.equal(
    resolveMemoryEntriesDirectory(stateRoot),
    join(stateRoot, 'memories', 'entries'),
  );
});
