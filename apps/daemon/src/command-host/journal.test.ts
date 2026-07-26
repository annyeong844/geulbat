import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCommandHostJournalPath,
  openSpawnJournal,
  readSpawnJournal,
  type JournalTerminalDescriptor,
} from './journal.js';

async function makeJournalRoot(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<string> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-journal-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  return stateRoot;
}

function openRow(index: number) {
  return {
    sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    outputRef: `command-output:thread/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    threadId: 'thread',
    pid: 1000 + index,
    pgid: 1000 + index,
    birthToken: `token-${index}`,
    gated: true,
  };
}

function terminal(): JournalTerminalDescriptor {
  return {
    status: 'exit',
    exitCode: 0,
    finalRevision: 3,
    stdoutBaseOffset: 0,
    stderrBaseOffset: 0,
    stdoutBytes: 4,
    stderrBytes: 0,
    stdoutChars: 4,
    stderrChars: 0,
    finishedAtMs: 1_700_000_000_000,
  };
}

void test('open rows survive a reopen and closed rows retire them', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);

  const first = await openSpawnJournal({ path, workerInstanceId: 'worker-a' });
  await first.appendOpen(openRow(1));
  await first.appendOpen(openRow(2));
  await first.appendClosed({
    sessionId: openRow(1).sessionId,
    phase: 'finished',
    terminal: terminal(),
  });
  await first.close();

  const contents = await readSpawnJournal(path);
  assert.equal(contents.ok, true);
  if (!contents.ok) {
    return;
  }
  assert.deepEqual(
    contents.open.map((row) => row.sessionId),
    [openRow(2).sessionId],
  );
  assert.equal(contents.closed.get(openRow(1).sessionId)?.phase, 'finished');
  assert.equal(contents.workerInstanceId, 'worker-a');

  // 재개방은 이전 세대의 open 집합을 그대로 이어받는다.
  const second = await openSpawnJournal({ path, workerInstanceId: 'worker-b' });
  assert.equal(second.stats().openRecords, 1);
  await second.close();
});

void test('an open row is durable before appendOpen resolves', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({ path, workerInstanceId: 'worker' });
  t.after(async () => {
    await journal.close();
  });

  await journal.appendOpen(openRow(7));
  // GO는 이 시점 이후에만 쓰인다 — 파일에 이미 보여야 한다 (§5.1).
  const raw = await readFile(path, 'utf8');
  assert.ok(raw.includes(openRow(7).sessionId));
});

void test('T11: the journal stays bounded across many short sessions', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({ path, workerInstanceId: 'worker' });
  t.after(async () => {
    await journal.close();
  });

  // 장수 세션 1개 + 짧은 세션 다수.
  await journal.appendOpen(openRow(0));
  for (let index = 1; index <= 1_200; index += 1) {
    await journal.appendOpen(openRow(index));
    await journal.appendClosed({
      sessionId: openRow(index).sessionId,
      phase: 'finished',
      terminal: terminal(),
    });
  }

  const stats = journal.stats();
  assert.equal(stats.openRecords, 1, 'the long-lived session is still open');
  assert.ok(
    stats.closedRecords <= 256,
    `closed rows must be compacted away, saw ${stats.closedRecords}`,
  );
  const size = (await stat(path)).size;
  assert.ok(size < 1024 * 1024, `journal must stay bounded, saw ${size} bytes`);

  const contents = await readSpawnJournal(path);
  assert.equal(contents.ok, true);
  if (contents.ok) {
    assert.deepEqual(
      contents.open.map((row) => row.sessionId),
      [openRow(0).sessionId],
      'compaction must preserve the exact open set',
    );
  }
});

void test('T23: concurrent appends across a compaction keep the open set exact', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({ path, workerInstanceId: 'worker' });

  // 압축 임계에 바짝 붙여 놓은 뒤, open/closed를 동시에 쏟아붓는다.
  for (let index = 1; index <= 300; index += 1) {
    await journal.appendOpen(openRow(index));
    await journal.appendClosed({
      sessionId: openRow(index).sessionId,
      phase: 'discarded',
    });
  }
  const survivors = [901, 902, 903, 904, 905];
  await Promise.all([
    ...survivors.map((index) => journal.appendOpen(openRow(index))),
    ...Array.from({ length: 200 }, (_unused, offset) =>
      journal.appendOpen(openRow(1000 + offset)).then(() =>
        journal.appendClosed({
          sessionId: openRow(1000 + offset).sessionId,
          phase: 'finished',
          terminal: terminal(),
        }),
      ),
    ),
  ]);
  // 워커 크래시를 흉내내어 닫지 않고 곧바로 다시 읽는다.
  await journal.close();

  const contents = await readSpawnJournal(path);
  assert.equal(contents.ok, true);
  if (!contents.ok) {
    return;
  }
  assert.deepEqual(
    contents.open.map((row) => row.sessionId).sort(),
    survivors.map((index) => openRow(index).sessionId).sort(),
  );
});

void test('compaction keeps closed rows whose terminal metadata never landed', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({ path, workerInstanceId: 'worker' });
  t.after(async () => {
    await journal.close();
  });

  const dirty = openRow(42);
  await journal.appendOpen(dirty);
  await journal.appendClosed({
    sessionId: dirty.sessionId,
    phase: 'finished',
    terminal: terminal(),
    terminalMetaDirty: true,
  });
  // 압축을 유발할 만큼 평범한 세션을 흘려보낸다.
  for (let index = 1; index <= 600; index += 1) {
    await journal.appendOpen(openRow(index));
    await journal.appendClosed({
      sessionId: openRow(index).sessionId,
      phase: 'finished',
      terminal: terminal(),
    });
  }

  const contents = await readSpawnJournal(path);
  assert.equal(contents.ok, true);
  if (contents.ok) {
    // §5.3 3행 승격의 유일한 근거이므로 압축이 지워서는 안 된다.
    assert.equal(contents.closed.get(dirty.sessionId)?.terminalMetaDirty, true);
  }
});

void test('an unknown journal major is reported instead of being rewritten', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({ path, workerInstanceId: 'worker' });
  await journal.appendOpen(openRow(1));
  await journal.close();
  await writeFile(
    path,
    `${JSON.stringify({ kind: 'header', journalFormatVersion: 99, workerInstanceId: 'future' })}\n`,
  );

  const contents = await readSpawnJournal(path);
  assert.equal(contents.ok, false);
  if (!contents.ok) {
    assert.equal(contents.reason, 'unknown_format');
  }
  await assert.rejects(
    openSpawnJournal({ path, workerInstanceId: 'worker' }),
    /not readable/u,
  );
});

void test('a torn trailing line is ignored without losing earlier rows', async (t) => {
  const stateRoot = await makeJournalRoot(t);
  const path = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({ path, workerInstanceId: 'worker' });
  await journal.appendOpen(openRow(5));
  await journal.close();
  const raw = await readFile(path, 'utf8');
  await writeFile(path, `${raw}{"kind":"open","seq":9,"sessi`);

  const contents = await readSpawnJournal(path);
  assert.equal(contents.ok, true);
  if (contents.ok) {
    assert.deepEqual(
      contents.open.map((row) => row.sessionId),
      [openRow(5).sessionId],
    );
  }
});
