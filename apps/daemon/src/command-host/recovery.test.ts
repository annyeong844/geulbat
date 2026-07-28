import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHostCommandOutputRef,
  buildHostCommandPaths,
  collectUnreferencedHostCommandOutputs,
  listPersistedHostCommandSessions,
  type HostCommandMetadata,
} from '../daemon/host-command-output-store.js';
import {
  buildCommandHostJournalPath,
  openSpawnJournal,
  readSpawnJournal,
} from './journal.js';
import { readProcessBirthToken } from './process-identity.js';
import { recoverCommandHostState } from './recovery.js';

const THREAD_ID = 'thread-recovery';

async function makeStateRoot(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<string> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-recovery-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  return stateRoot;
}

function runningMetadata(outputRef: string): HostCommandMetadata {
  return {
    schemaVersion: 1,
    outputRef,
    threadId: THREAD_ID,
    runId: 'run-1',
    callId: 'call-1',
    status: 'running',
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutChars: 0,
    stderrChars: 0,
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: null,
    firstOutputAfterMs: null,
    revision: 2,
    stdinOpen: true,
    outputLimitExceeded: null,
  };
}

async function seedSession(args: {
  stateRoot: string;
  sessionId: string;
  metadata?: HostCommandMetadata | 'omit' | 'corrupt';
  artifacts?: boolean;
}): Promise<{ outputRef: string; directory: string }> {
  const outputRef = buildHostCommandOutputRef({
    threadId: THREAD_ID,
    sessionId: args.sessionId,
  });
  const paths = buildHostCommandPaths({
    stateRoot: args.stateRoot,
    threadId: THREAD_ID,
    outputRef,
  });
  await mkdir(paths.directory, { recursive: true });
  if (args.metadata === 'corrupt') {
    await writeFile(paths.metadata, '{not json');
  } else if (args.metadata !== 'omit') {
    await writeFile(
      paths.metadata,
      `${JSON.stringify(args.metadata ?? runningMetadata(outputRef), null, 2)}\n`,
    );
  }
  if (args.artifacts !== false) {
    await writeFile(paths.stdout, 'done\n');
    await writeFile(paths.stderr, '');
  }
  return { outputRef, directory: paths.directory };
}

async function readMetadata(
  stateRoot: string,
  outputRef: string,
): Promise<HostCommandMetadata> {
  const paths = buildHostCommandPaths({
    stateRoot,
    threadId: THREAD_ID,
    outputRef,
  });
  const parsed: unknown = JSON.parse(await readFile(paths.metadata, 'utf8'));
  return parsed as HostCommandMetadata;
}

function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

void test('§5.3 row 3: a journal closed row promotes a running record to finished', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const id = sessionId(1);
  const seeded = await seedSession({ stateRoot, sessionId: id });

  // artifact는 남았지만 terminal metadata 기록이 실패한 상태를 재현한다.
  const journal = await openSpawnJournal({
    path: buildCommandHostJournalPath(stateRoot),
    workerInstanceId: 'worker-dead',
  });
  await journal.appendOpen({
    sessionId: id,
    outputRef: seeded.outputRef,
    threadId: THREAD_ID,
    pid: 999_999,
    pgid: 999_999,
    birthToken: null,
    gated: true,
  });
  await journal.appendClosed({
    sessionId: id,
    phase: 'finished',
    terminalMetaDirty: true,
    terminal: {
      status: 'exit',
      exitCode: 0,
      finalRevision: 9,
      stdoutBaseOffset: 0,
      stderrBaseOffset: 0,
      stdoutBytes: 5,
      stderrBytes: 0,
      stdoutChars: 5,
      stderrChars: 0,
      finishedAtMs: 1_700_000_009_000,
      terminationReason: 'explicit_terminate',
    },
  });
  await journal.close();

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.promotedToFinished, 1);
  assert.equal(report.markedInterrupted, 0);

  const metadata = await readMetadata(stateRoot, seeded.outputRef);
  assert.equal(metadata.status, 'exit');
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.finalRevision, 9);
  assert.equal(metadata.terminationReason, 'explicit_terminate');
  assert.equal(metadata.stdinOpen, false);
});

void test('§5.3 row 4: a closed row with a failed artifact converges to interrupted', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const id = sessionId(2);
  const seeded = await seedSession({
    stateRoot,
    sessionId: id,
    artifacts: false,
  });
  const journal = await openSpawnJournal({
    path: buildCommandHostJournalPath(stateRoot),
    workerInstanceId: 'worker-dead',
  });
  await journal.appendClosed({
    sessionId: id,
    phase: 'finished',
    terminalMetaDirty: true,
    terminal: {
      status: 'exit',
      exitCode: 0,
      finalRevision: 4,
      stdoutBaseOffset: 0,
      stderrBaseOffset: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutChars: 0,
      stderrChars: 0,
      finishedAtMs: 1_700_000_009_000,
      outputPersistFailed: true,
    },
  });
  await journal.close();

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.promotedToFinished, 0);
  assert.equal(report.markedInterrupted, 1);
  const metadata = await readMetadata(stateRoot, seeded.outputRef);
  assert.equal(metadata.status, 'command_host_interrupted');
  assert.equal(metadata.terminationReason, 'command_host_lost');
});

void test('§5.5: running metadata without a journal row becomes command_host_interrupted', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const seeded = await seedSession({ stateRoot, sessionId: sessionId(3) });

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.markedInterrupted, 1);
  const metadata = await readMetadata(stateRoot, seeded.outputRef);
  assert.equal(metadata.status, 'command_host_interrupted');
});

void test('§5.2: claim-metadata-less directories, temp files and strays are collected', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const orphan = await seedSession({
    stateRoot,
    sessionId: sessionId(4),
    metadata: 'omit',
  });
  const kept = await seedSession({ stateRoot, sessionId: sessionId(5) });
  await writeFile(join(kept.directory, 'metadata.json.tmp-abcd'), 'partial');
  const strayDirectory = join(
    stateRoot,
    '.geulbat',
    'tool-outputs',
    THREAD_ID,
    'command-sessions',
    'not-a-session-id',
  );
  await mkdir(strayDirectory, { recursive: true });

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.removedIncomplete, 1);
  assert.ok(report.removedTempArtifacts >= 2);
  assert.equal(await pathExists(orphan.directory), false);
  assert.equal(await pathExists(strayDirectory), false);
  assert.equal(
    await pathExists(join(kept.directory, 'metadata.json.tmp-abcd')),
    false,
  );
  assert.equal(await pathExists(kept.directory), true);
});

void test('recovery preserves a session when metadata cannot be read for a reason other than absence', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const seeded = await seedSession({
    stateRoot,
    sessionId: sessionId(18),
  });
  const paths = buildHostCommandPaths({
    stateRoot,
    threadId: THREAD_ID,
    outputRef: seeded.outputRef,
  });
  await rm(paths.metadata);
  await mkdir(paths.metadata);

  await assert.rejects(recoverCommandHostState({ stateRoot }), {
    code: 'EISDIR',
  });
  assert.equal(await pathExists(seeded.directory), true);
});

void test('§5.2: an open row with an unverifiable birth token is never killed', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const journal = await openSpawnJournal({
    path: buildCommandHostJournalPath(stateRoot),
    workerInstanceId: 'worker-dead',
  });
  // 살아 있는 이 프로세스를 겨냥하되 토큰은 맞지 않게 심는다 — 검증 실패
  // 시 kill이 금지되므로 우리는 살아남아야 한다.
  await journal.appendOpen({
    sessionId: sessionId(6),
    outputRef: buildHostCommandOutputRef({
      threadId: THREAD_ID,
      sessionId: sessionId(6),
    }),
    threadId: THREAD_ID,
    pid: process.pid,
    pgid: process.pid,
    birthToken: 'linux:starttime:0',
    gated: true,
  });
  await journal.close();

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.reapedProcessGroups, 0);
  assert.equal(report.unverifiedOrphans, 1);
});

void test('§5.2: a matching birth token authorises the process group kill', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const token = await readProcessBirthToken(process.pid);
  if (token === null) {
    t.skip('platform cannot verify process identity');
    return;
  }
  const journal = await openSpawnJournal({
    path: buildCommandHostJournalPath(stateRoot),
    workerInstanceId: 'worker-dead',
  });
  await journal.appendOpen({
    sessionId: sessionId(7),
    outputRef: buildHostCommandOutputRef({
      threadId: THREAD_ID,
      sessionId: sessionId(7),
    }),
    threadId: THREAD_ID,
    pid: process.pid,
    // 자기 자신을 죽이지 않도록 존재하지 않는 그룹을 가리킨다. 검증은
    // pid 기준이고 kill 시도만 실패한다.
    pgid: 2_147_483_646,
    birthToken: token,
    gated: true,
  });
  await journal.close();

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.unverifiedOrphans, 0, 'the token verified');
  assert.equal(report.reapedProcessGroups, 0, 'the group no longer exists');
});

void test('reap leaves no journal residue behind', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const journalPath = buildCommandHostJournalPath(stateRoot);
  const journal = await openSpawnJournal({
    path: journalPath,
    workerInstanceId: 'worker-dead',
  });
  await journal.appendOpen({
    sessionId: sessionId(8),
    outputRef: buildHostCommandOutputRef({
      threadId: THREAD_ID,
      sessionId: sessionId(8),
    }),
    threadId: THREAD_ID,
    pid: 999_998,
    pgid: 999_998,
    birthToken: null,
    gated: true,
  });
  await journal.close();

  await recoverCommandHostState({ stateRoot });
  const contents = await readSpawnJournal(journalPath);
  assert.equal(contents.ok, false, 'the previous generation journal is gone');
});

void test('an unreadable journal major is quarantined instead of deleted', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const journalPath = buildCommandHostJournalPath(stateRoot);
  await mkdir(join(stateRoot, '.geulbat', 'command-host'), { recursive: true });
  await writeFile(
    journalPath,
    `${JSON.stringify({ kind: 'header', journalFormatVersion: 99, workerInstanceId: 'future' })}\n`,
  );

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.quarantined, 1);
  assert.equal(await pathExists(journalPath), false);
  assert.equal(await pathExists(`${journalPath}.unreadable-v99`), true);
});

void test('T8: unreferenced claimed outputs are collected while live sessions survive', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const referenced = await seedSession({ stateRoot, sessionId: sessionId(10) });
  const live = await seedSession({ stateRoot, sessionId: sessionId(11) });
  const orphan = await seedSession({ stateRoot, sessionId: sessionId(12) });

  const deleted = await collectUnreferencedHostCommandOutputs({
    stateRoot,
    threadId: THREAD_ID,
    preservedOutputRefs: new Set([referenced.outputRef, live.outputRef]),
  });

  assert.equal(deleted, 1);
  assert.equal(await pathExists(orphan.directory), false);
  assert.equal(await pathExists(referenced.directory), true);
  assert.equal(await pathExists(live.directory), true);
});

void test('session enumeration separates real sessions from strays', async (t) => {
  const stateRoot = await makeStateRoot(t);
  await seedSession({ stateRoot, sessionId: sessionId(20) });
  await mkdir(
    join(
      stateRoot,
      '.geulbat',
      'tool-outputs',
      THREAD_ID,
      'command-sessions',
      'leftover.tmp-1',
    ),
    { recursive: true },
  );

  const listed = await listPersistedHostCommandSessions({ stateRoot });
  assert.deepEqual(
    listed.sessions.map((session) => session.sessionId),
    [sessionId(20)],
  );
  assert.equal(listed.strays.length, 1);
});

void test('§5.2: a session marked interrupted is still a reap candidate', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const id = sessionId(30);
  // 링을 잃었을 뿐 자식은 고아로 살아 있을 수 있다 — metadata를
  // command_host_interrupted로 적었다는 사실이 kill을 면제하지 않는다.
  await seedSession({ stateRoot, sessionId: id, artifacts: false });
  const journal = await openSpawnJournal({
    path: buildCommandHostJournalPath(stateRoot),
    workerInstanceId: 'worker-dead',
  });
  await journal.appendOpen({
    sessionId: id,
    outputRef: buildHostCommandOutputRef({
      threadId: THREAD_ID,
      sessionId: id,
    }),
    threadId: THREAD_ID,
    pid: process.pid,
    pgid: 2_147_483_646,
    birthToken: 'linux:starttime:0',
    gated: true,
  });
  await journal.close();

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.markedInterrupted, 1);
  // reap 대상에서 빠지지 않았다는 증거: 검증까지 갔다(토큰 불일치로 kill은
  // 금지됐지만, 건너뛰었다면 이 카운터가 0이다).
  assert.equal(report.unverifiedOrphans, 1);
});

void test('§5.2: a session already terminal on disk is not reaped again', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const id = sessionId(31);
  await seedSession({
    stateRoot,
    sessionId: id,
    metadata: {
      ...runningMetadata(
        buildHostCommandOutputRef({ threadId: THREAD_ID, sessionId: id }),
      ),
      status: 'exit',
      exitCode: 0,
      finishedAtMs: 1_700_000_005_000,
    },
  });
  const journal = await openSpawnJournal({
    path: buildCommandHostJournalPath(stateRoot),
    workerInstanceId: 'worker-dead',
  });
  await journal.appendOpen({
    sessionId: id,
    outputRef: buildHostCommandOutputRef({
      threadId: THREAD_ID,
      sessionId: id,
    }),
    threadId: THREAD_ID,
    pid: process.pid,
    pgid: 2_147_483_646,
    birthToken: 'linux:starttime:0',
    gated: true,
  });
  await journal.close();

  const report = await recoverCommandHostState({ stateRoot });
  assert.equal(report.markedInterrupted, 0);
  assert.equal(report.unverifiedOrphans, 0, 'ended sessions skip the reap');
});
