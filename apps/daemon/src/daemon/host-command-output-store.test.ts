import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHostCommandOutputRef,
  buildHostCommandPaths,
  collectUnreferencedHostCommandOutputs,
  HOST_COMMAND_ARTIFACT_FORMAT_VERSION,
  markPersistedHostCommandInterrupted,
  readHostCommandArtifactFormatVersion,
  parseHostCommandOutputRef,
  pruneUnreferencedThreadHostCommandOutputs,
  readHostCommandOutputPage,
  readPersistedHostCommand,
  removeHostCommandDirectory,
  snapshotFromHostCommandMetadata,
  writeHostCommandMetadata,
  type HostCommandMetadata,
  type HostCommandPaths,
} from './host-command-output-store.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000301';

function makeMetadata(
  threadId: string,
  overrides: Partial<HostCommandMetadata> = {},
): HostCommandMetadata {
  return {
    schemaVersion: 1,
    outputRef: buildHostCommandOutputRef({ threadId, sessionId: SESSION_ID }),
    threadId,
    runId: 'run-host-output',
    callId: 'call-host-output',
    status: 'exit',
    exitCode: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutChars: 0,
    stderrChars: 0,
    startedAtMs: 1_000,
    finishedAtMs: 2_000,
    firstOutputAfterMs: 5,
    revision: 1,
    stdinOpen: false,
    outputLimitExceeded: null,
    ...overrides,
  };
}

async function seedSession(
  stateRoot: string,
  threadId: string,
): Promise<{ outputRef: string; paths: HostCommandPaths }> {
  const outputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: SESSION_ID,
  });
  const paths = buildHostCommandPaths({ stateRoot, threadId, outputRef });
  await mkdir(paths.directory, { recursive: true });
  return { outputRef, paths };
}

void test('parseHostCommandOutputRef distinguishes non-references, malformed refs, and undecodable thread ids', () => {
  assert.deepEqual(parseHostCommandOutputRef('plain-ref'), {
    ok: false,
    reasonCode: 'invalid_args',
    message: 'outputRef is not a host command output reference.',
  });

  const badSession = parseHostCommandOutputRef(
    'command-output:thread/not-a-uuid',
  );
  assert.equal(badSession.ok, false);
  if (!badSession.ok) {
    assert.equal(
      badSession.message,
      'host command output reference is malformed.',
    );
  }

  assert.equal(
    parseHostCommandOutputRef(`command-output:a/b/${SESSION_ID}`).ok,
    false,
  );

  const undecodable = parseHostCommandOutputRef(
    `command-output:%E0%A4%A/${SESSION_ID}`,
  );
  assert.equal(undecodable.ok, false);
  if (!undecodable.ok) {
    assert.equal(
      undecodable.message,
      'host command output reference is malformed.',
    );
  }

  const roundTripped = parseHostCommandOutputRef(
    buildHostCommandOutputRef({
      threadId: 'thread/with space',
      sessionId: SESSION_ID,
    }),
  );
  assert.equal(roundTripped.ok, true);
  if (roundTripped.ok) {
    assert.equal(roundTripped.threadId, 'thread/with space');
    assert.equal(roundTripped.sessionId, SESSION_ID);
  }
});

void test('buildHostCommandPaths rejects an output reference owned by a different thread', () => {
  const outputRef = buildHostCommandOutputRef({
    threadId: 'thread-a',
    sessionId: SESSION_ID,
  });
  assert.throws(
    () =>
      buildHostCommandPaths({
        stateRoot: '/state',
        threadId: 'thread-b',
        outputRef,
      }),
    /does not match thread/,
  );
});

void test('readPersistedHostCommand round-trips metadata and reports typed failures', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-host-output-read-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const threadId = 'thread-host-read';
  const { outputRef, paths } = await seedSession(stateRoot, threadId);

  const missing = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reasonCode, 'not_found');
  }

  const metadata = makeMetadata(threadId);
  await writeHostCommandMetadata({ paths, metadata });
  const read = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.deepEqual(read.value.metadata, metadata);
    assert.equal(read.value.paths.metadata, paths.metadata);
  }

  await writeFile(paths.metadata, '{ not valid json', 'utf8');
  const badJson = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(badJson.ok, false);
  if (!badJson.ok) {
    assert.equal(badJson.reasonCode, 'output_store_failed');
  }

  for (const corruption of [
    { status: 'bogus' },
    { stdoutBytes: -1 },
    { outputLimitExceeded: { stream: 'nope', maxOutputBytesPerStream: 1 } },
    { schemaVersion: 2 },
  ]) {
    await writeFile(
      paths.metadata,
      JSON.stringify({ ...metadata, ...corruption }),
      'utf8',
    );
    const mismatch = await readPersistedHostCommand({
      stateRoot,
      threadId,
      outputRef,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.reasonCode, 'output_store_failed');
    }
  }
});

void test('markPersistedHostCommandInterrupted rewrites status from disk and reports fs failures', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-host-output-mark-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const threadId = 'thread-host-mark';
  const { outputRef, paths } = await seedSession(stateRoot, threadId);
  await writeHostCommandMetadata({
    paths,
    metadata: makeMetadata(threadId, { status: 'running' }),
  });
  await writeFile(paths.stdout, 'abc', 'utf8');
  await writeFile(paths.stderr, 'de', 'utf8');

  const loaded = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    return;
  }

  const marked = await markPersistedHostCommandInterrupted(loaded.value);
  assert.equal(marked.ok, true);
  if (marked.ok) {
    assert.equal(marked.value.metadata.status, 'daemon_restart_interrupted');
    assert.equal(marked.value.metadata.stdoutBytes, 3);
    assert.equal(marked.value.metadata.stderrBytes, 2);
    assert.equal(marked.value.metadata.exitCode, null);
    assert.equal(
      marked.value.metadata.revision,
      loaded.value.metadata.revision + 1,
    );
  }

  await rm(paths.stdout, { force: true });
  const failed = await markPersistedHostCommandInterrupted(loaded.value);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.reasonCode, 'output_store_failed');
  }
});

void test('readHostCommandOutputPage paginates utf-8 output and enforces byte boundaries', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-host-output-page-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const threadId = 'thread-host-page';
  const { paths } = await seedSession(stateRoot, threadId);
  // Two 3-byte Hangul syllables repeated: 12 bytes total.
  await writeFile(paths.stdout, '한글한글', 'utf8');

  assert.deepEqual(
    await readHostCommandOutputPage({
      paths,
      page: undefined,
      inlineMaxBytes: 100,
    }),
    { ok: true, value: null },
  );

  const over = await readHostCommandOutputPage({
    paths,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 200 },
    inlineMaxBytes: 100,
  });
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.reasonCode, 'invalid_args');
  }

  const firstPage = await readHostCommandOutputPage({
    paths,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 6 },
    inlineMaxBytes: 100,
  });
  assert.equal(firstPage.ok, true);
  if (firstPage.ok && firstPage.value) {
    assert.equal(firstPage.value.content, '한글');
    assert.equal(firstPage.value.hasMore, true);
    assert.equal(firstPage.value.nextOffsetBytes, 6);
    assert.equal(firstPage.value.totalBytes, 12);
  }

  const secondPage = await readHostCommandOutputPage({
    paths,
    page: { stream: 'stdout', offsetBytes: 6, limitBytes: 6 },
    inlineMaxBytes: 100,
  });
  assert.equal(secondPage.ok, true);
  if (secondPage.ok && secondPage.value) {
    assert.equal(secondPage.value.content, '한글');
    assert.equal(secondPage.value.hasMore, false);
    assert.equal(secondPage.value.nextOffsetBytes, null);
  }

  await writeFile(paths.stdoutFull, '처음부터 보존', 'utf8');
  const fullArchivePage = await readHostCommandOutputPage({
    paths,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 100 },
    inlineMaxBytes: 100,
    fullOutputAvailable: true,
  });
  assert.equal(fullArchivePage.ok, true);
  if (fullArchivePage.ok && fullArchivePage.value) {
    assert.equal(fullArchivePage.value.content, '처음부터 보존');
    assert.equal(fullArchivePage.value.totalBytes, 19);
    assert.equal(fullArchivePage.value.hasMore, false);
  }

  const midCharacter = await readHostCommandOutputPage({
    paths,
    page: { stream: 'stdout', offsetBytes: 1, limitBytes: 6 },
    inlineMaxBytes: 100,
  });
  assert.equal(midCharacter.ok, false);
  if (!midCharacter.ok) {
    assert.equal(midCharacter.reasonCode, 'invalid_args');
  }

  const tooSmall = await readHostCommandOutputPage({
    paths,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 1 },
    inlineMaxBytes: 100,
  });
  assert.equal(tooSmall.ok, false);
  if (!tooSmall.ok) {
    assert.equal(tooSmall.reasonCode, 'invalid_args');
  }

  const missingFile = await readHostCommandOutputPage({
    paths: { ...paths, stdout: `${paths.stdout}-absent` },
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 6 },
    inlineMaxBytes: 100,
  });
  assert.equal(missingFile.ok, false);
  if (!missingFile.ok) {
    assert.equal(missingFile.reasonCode, 'output_store_failed');
  }
});

void test('snapshotFromHostCommandMetadata projects metadata and derives duration', () => {
  const finished = snapshotFromHostCommandMetadata(
    makeMetadata('thread-snapshot', {
      startedAtMs: 1_000,
      finishedAtMs: 1_500,
    }),
  );
  assert.equal(finished.durationMs, 500);
  assert.equal(finished.status, 'exit');
  assert.equal(finished.stdout, null);
  assert.equal(finished.stderr, null);
  assert.equal(finished.outputComplete, false);
  assert.equal(finished.stdinOpen, false);

  const running = snapshotFromHostCommandMetadata(
    makeMetadata('thread-snapshot', {
      status: 'running',
      startedAtMs: 0,
      finishedAtMs: null,
    }),
  );
  assert.equal(running.durationMs >= 0, true);
});

void test('removeHostCommandDirectory deletes a session tree and tolerates a missing path', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-host-output-remove-'),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const { paths } = await seedSession(stateRoot, 'thread-host-remove');
  await writeFile(paths.stdout, 'x', 'utf8');

  await removeHostCommandDirectory(paths.directory);
  await assert.rejects(
    stat(paths.directory),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );

  // A second removal of the now-missing directory must not throw.
  await removeHostCommandDirectory(paths.directory);
});

void test('host command output pruning removes only refs that left the owning thread transcript', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-host-output-prune-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const threadId = 'thread-host-output-prune';
  const retainedOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000201',
  });
  const removedOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000202',
  });
  const foreignOutputRef = buildHostCommandOutputRef({
    threadId: 'thread-host-output-foreign',
    sessionId: '00000000-0000-4000-8000-000000000203',
  });
  const retainedPaths = await createOutputDirectory(
    stateRoot,
    threadId,
    retainedOutputRef,
  );
  const removedPaths = await createOutputDirectory(
    stateRoot,
    threadId,
    removedOutputRef,
  );

  const deleted = await pruneUnreferencedThreadHostCommandOutputs({
    stateRoot,
    threadId,
    previousOutputRefs: new Set([
      retainedOutputRef,
      removedOutputRef,
      foreignOutputRef,
    ]),
    retainedOutputRefs: new Set([retainedOutputRef]),
  });

  assert.equal(deleted, 1);
  assert.equal((await stat(retainedPaths.directory)).isDirectory(), true);
  await assert.rejects(
    stat(removedPaths.directory),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );

  // Re-pruning an already-removed ref is a no-op and stays at zero deletions.
  const secondPass = await pruneUnreferencedThreadHostCommandOutputs({
    stateRoot,
    threadId,
    previousOutputRefs: new Set([removedOutputRef]),
    retainedOutputRefs: new Set(),
  });
  assert.equal(secondPass, 0);
});

async function createOutputDirectory(
  stateRoot: string,
  threadId: string,
  outputRef: string,
) {
  const paths = buildHostCommandPaths({ stateRoot, threadId, outputRef });
  await mkdir(paths.directory, { recursive: true });
  await Promise.all([
    writeFile(paths.stdout, 'stdout', 'utf8'),
    writeFile(paths.stderr, '', 'utf8'),
  ]);
  return paths;
}

void test('T22: an artifact written before formatVersion existed still reads', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-fmt-n-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  const threadId = 'thread-format-n';
  const outputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: SESSION_ID,
  });
  const paths = buildHostCommandPaths({ stateRoot, threadId, outputRef });
  await mkdir(paths.directory, { recursive: true });
  // 버전 N 산출물의 실제 모양 — formatVersion·sessionId·baseOffset이 아직
  // 없던 시절이다 (§5.4 A안: 같은 major의 과거 산출물은 계속 읽는다).
  await writeFile(
    paths.metadata,
    `${JSON.stringify({
      schemaVersion: 1,
      outputRef,
      threadId,
      runId: 'run-old',
      callId: 'call-old',
      status: 'exit',
      exitCode: 0,
      stdoutBytes: 5,
      stderrBytes: 0,
      stdoutChars: 5,
      stderrChars: 0,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
      firstOutputAfterMs: 1,
      revision: 4,
      stdinOpen: false,
      outputLimitExceeded: null,
    })}\n`,
  );
  await writeFile(paths.stdout, 'older');
  await writeFile(paths.stderr, '');

  const read = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(read.ok, true);
  if (!read.ok) {
    return;
  }
  assert.equal(read.value.metadata.status, 'exit');
  const page = await readHostCommandOutputPage({
    paths: read.value.paths,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 16 },
    inlineMaxBytes: 1024,
  });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.equal(page.value?.content, 'older');
  }
});

void test('T22: an artifact carrying unknown additive fields still reads', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-fmt-nk-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  const threadId = 'thread-format-nk';
  const outputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: SESSION_ID,
  });
  const paths = buildHostCommandPaths({ stateRoot, threadId, outputRef });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.metadata,
    `${JSON.stringify({
      ...makeMetadata(threadId),
      formatVersion: HOST_COMMAND_ARTIFACT_FORMAT_VERSION,
      sessionId: SESSION_ID,
      // 같은 major 안에서 나중에 추가된 필드 — 모르는 필드는 무시하고 읽는다.
      someFutureAdditiveField: { nested: true },
    })}\n`,
  );

  const read = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.value.metadata.status, 'exit');
  }
});

void test('§5.4: an unknown format major is neither read nor collected', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-fmt-future-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  const threadId = 'thread-format-future';
  const outputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: SESSION_ID,
  });
  const paths = buildHostCommandPaths({ stateRoot, threadId, outputRef });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.metadata,
    `${JSON.stringify({
      ...makeMetadata(threadId),
      formatVersion: HOST_COMMAND_ARTIFACT_FORMAT_VERSION + 1,
      schemaVersion: 1,
    })}\n`,
  );

  const read = await readPersistedHostCommand({
    stateRoot,
    threadId,
    outputRef,
  });
  assert.equal(read.ok, false, 'a major we do not understand is not read');

  const deleted = await collectUnreferencedHostCommandOutputs({
    stateRoot,
    threadId,
    preservedOutputRefs: new Set(),
  });
  assert.equal(deleted, 0, 'and it is isolated, not collected');
  assert.equal((await stat(paths.metadata)).isFile(), true);
});

void test('the format major is read from formatVersion first, schemaVersion second', () => {
  assert.equal(
    readHostCommandArtifactFormatVersion({ schemaVersion: 1 }),
    1,
    'pre-formatVersion artifacts still declare a major',
  );
  assert.equal(
    readHostCommandArtifactFormatVersion({
      formatVersion: 2,
      schemaVersion: 1,
    }),
    2,
    'formatVersion wins so an old field cannot mask a new major',
  );
  assert.equal(readHostCommandArtifactFormatVersion({}), undefined);
  assert.equal(readHostCommandArtifactFormatVersion(null), undefined);
});
