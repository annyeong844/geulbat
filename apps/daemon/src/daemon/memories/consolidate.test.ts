import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { consolidateMemory, parseMemoryEntryDrafts } from './consolidate.js';
import {
  commitMemoryEntries,
  readMemoryEntries,
  recordMemoryEntryUsage,
} from './entries-store.js';
import {
  appendMemoryNote,
  listPendingMemoryNotes,
  resolveMemorySummaryPath,
} from './notes-store.js';

async function makeStateRootWithNotes(count: number): Promise<string> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-consolidate-'));
  for (let index = 0; index < count; index += 1) {
    await appendMemoryNote(stateRoot, `note ${index}`);
  }
  return stateRoot;
}

void test('the parser keeps known addresses and demotes anything else to a new entry', () => {
  const drafts = parseMemoryEntryDrafts(
    [
      'preamble the model should not have written',
      '[m-11111111] kept entry',
      'second line of the kept entry',
      '[new] a fresh entry',
      '[m-99999999] an address that no longer exists',
      '[m-11111111] a duplicate claim on the same address',
      '[new]    ',
    ].join('\n'),
    new Set(['m-11111111']),
  );

  assert.deepEqual(drafts, [
    { id: 'm-11111111', text: 'kept entry\nsecond line of the kept entry' },
    { id: undefined, text: 'a fresh entry' },
    { id: undefined, text: 'an address that no longer exists' },
    { id: undefined, text: 'a duplicate claim on the same address' },
  ]);
});

void test('consolidation is skipped until the pending notes reach the threshold', async () => {
  const stateRoot = await makeStateRootWithNotes(9);
  let called = false;

  const result = await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate() {
        called = true;
        return { text: '[new] should not happen' };
      },
    },
  });

  assert.deepEqual(result, { kind: 'skipped', reason: 'not_due' });
  assert.equal(called, false);
  assert.deepEqual(await readMemoryEntries(stateRoot), []);
});

void test('consolidation replaces the entry set and clears the pending notes', async () => {
  const stateRoot = await makeStateRootWithNotes(10);

  const result = await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate({ entries, notes }) {
        assert.deepEqual(entries, []);
        assert.equal(notes.length, 10);
        return { text: '[new] first fact\n[new] second fact' };
      },
    },
  });

  assert.deepEqual(result, {
    kind: 'consolidated',
    entryCount: 2,
    consolidatedNoteCount: 10,
  });
  assert.deepEqual(
    (await readMemoryEntries(stateRoot)).map((entry) => entry.text).sort(),
    ['first fact', 'second fact'],
  );
  assert.deepEqual(await listPendingMemoryNotes(stateRoot), []);
});

void test('measured usage reaches the consolidation input and a kept address survives', async () => {
  const stateRoot = await makeStateRootWithNotes(10);
  const { entryIds } = await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'existing fact' },
  ]);
  const entryId = entryIds[0]!;
  await recordMemoryEntryUsage(stateRoot, [entryId]);
  await recordMemoryEntryUsage(stateRoot, [entryId]);

  let seenUsageCount: number | undefined;
  await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate({ entries }) {
        seenUsageCount = entries[0]?.usageCount;
        return { text: `[${entryId}] existing fact, reworded` };
      },
    },
  });

  assert.equal(seenUsageCount, 2);
  const entries = await readMemoryEntries(stateRoot);
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.text, entry.usageCount]),
    [[entryId, 'existing fact, reworded', 2]],
  );
});

void test('a legacy summary is passed in once and removed after it is absorbed', async () => {
  const stateRoot = await makeStateRootWithNotes(10);
  await writeFile(
    resolveMemorySummaryPath(stateRoot),
    '## 사용자\n존댓말을 쓴다\n',
    'utf8',
  );

  let seenLegacy: string | undefined;
  await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate({ legacySummary }) {
        seenLegacy = legacySummary;
        return { text: '[new] 수연은 존댓말을 쓴다' };
      },
    },
  });

  assert.equal(seenLegacy, '## 사용자\n존댓말을 쓴다');
  await assert.rejects(
    async () =>
      await import('node:fs/promises').then(async (fs) =>
        fs.readFile(resolveMemorySummaryPath(stateRoot), 'utf8'),
      ),
  );
});

void test('the previous entries are kept when the model call fails', async () => {
  const stateRoot = await makeStateRootWithNotes(10);
  await commitMemoryEntries(stateRoot, [
    { id: undefined, text: 'survives the failure' },
  ]);

  const result = await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate() {
        throw new Error('provider unavailable');
      },
    },
  });

  assert.deepEqual(result, { kind: 'failed', reason: 'summarizer_failed' });
  assert.deepEqual(
    (await readMemoryEntries(stateRoot)).map((entry) => entry.text),
    ['survives the failure'],
  );
  assert.equal((await listPendingMemoryNotes(stateRoot)).length, 10);
});

void test('output with no parseable entry leaves memory and the pending notes alone', async () => {
  const stateRoot = await makeStateRootWithNotes(10);

  const result = await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate() {
        return { text: 'I have decided not to use the required format.' };
      },
    },
  });

  assert.deepEqual(result, { kind: 'failed', reason: 'no_entries_parsed' });
  assert.deepEqual(await readMemoryEntries(stateRoot), []);
  assert.equal((await listPendingMemoryNotes(stateRoot)).length, 10);
});

void test('a second consolidation for the same state root is skipped while one runs', async () => {
  const stateRoot = await makeStateRootWithNotes(10);
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate() {
        await blocked;
        return { text: '[new] from the first pass' };
      },
    },
  });
  const second = await consolidateMemory({
    stateRoot,
    summarizer: {
      async consolidate() {
        return { text: '[new] from the second pass' };
      },
    },
  });
  release?.();

  assert.deepEqual(second, { kind: 'skipped', reason: 'already_running' });
  assert.equal((await first).kind, 'consolidated');
  assert.deepEqual(
    (await readMemoryEntries(stateRoot)).map((entry) => entry.text),
    ['from the first pass'],
  );
});
