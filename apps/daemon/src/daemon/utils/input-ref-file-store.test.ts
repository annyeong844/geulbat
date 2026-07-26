import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';

import {
  claimInputRefFilePath,
  deleteInputRefFilePath,
  listInputRefFiles,
  readInputRefFilePath,
  recoverInputRefFile,
  writeInputRefFileFromStream,
  type InputRefFileStoreConfig,
} from './input-ref-file-store.js';

const TEST_STORE: InputRefFileStoreConfig = Object.freeze({
  kind: 'run_prompt',
  refPrefix: 'test-input:',
  directoryName: 'test-inputs',
  fileExtension: '.txt',
  invalidPrefixMessage: 'invalid prefix',
  invalidIdMessage: 'invalid id',
  notFileMessage: 'not a file',
  notFoundMessage: 'not found',
  claimedMessage: 'already claimed',
});

void test('input refs transfer atomically to one consumer without changing bytes', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-input-ref-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const expected = 'large input stays byte-exact\n';
  const uploaded = await writeInputRefFileFromStream({
    workspaceRoot,
    input: Readable.from([expected]),
    config: TEST_STORE,
  });
  const pendingInventory = await listInputRefFiles({
    workspaceRoot,
    config: TEST_STORE,
  });
  assert.equal(pendingInventory.length, 1);
  assert.equal(pendingInventory[0]?.state, 'pending');
  assert.equal(pendingInventory[0]?.byteLength, Buffer.byteLength(expected));

  const claims = await Promise.all([
    claimInputRefFilePath({
      workspaceRoot,
      ref: uploaded.ref,
      config: TEST_STORE,
    }),
    claimInputRefFilePath({
      workspaceRoot,
      ref: uploaded.ref,
      config: TEST_STORE,
    }),
  ]);
  const accepted = claims.filter((result) => result.ok);
  const rejected = claims.filter((result) => !result.ok);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.ok, false);
  if (rejected[0]?.ok !== false || accepted[0]?.ok !== true) {
    assert.fail('expected one accepted claim and one rejected claim');
  }
  assert.equal(rejected[0].code, 'conflict');
  assert.equal(await readFile(accepted[0].path, 'utf8'), expected);
  const claimedInventory = await listInputRefFiles({
    workspaceRoot,
    config: TEST_STORE,
  });
  assert.equal(claimedInventory.length, 1);
  assert.equal(claimedInventory[0]?.state, 'claimed');
  assert.equal(claimedInventory[0]?.claimId?.length, 36);

  const pendingLookup = await readInputRefFilePath({
    workspaceRoot,
    ref: uploaded.ref,
    config: TEST_STORE,
  });
  assert.deepEqual(pendingLookup, {
    ok: false,
    code: 'conflict',
    message: 'already claimed',
  });

  await deleteInputRefFilePath(accepted[0].path);
  const afterConsume = await readInputRefFilePath({
    workspaceRoot,
    ref: uploaded.ref,
    config: TEST_STORE,
  });
  assert.deepEqual(afterConsume, {
    ok: false,
    code: 'not_found',
    message: 'not found',
  });
  assert.deepEqual(
    await listInputRefFiles({ workspaceRoot, config: TEST_STORE }),
    [],
  );
});

void test('persisted claims surface as interrupted until explicitly retried or released', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-input-ref-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const id = randomUUID();
  const claimId = randomUUID();
  const ref = `${TEST_STORE.refPrefix}${id}`;
  const directory = join(workspaceRoot, '.geulbat', TEST_STORE.directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.${claimId}.claimed${TEST_STORE.fileExtension}`),
    'recover me',
    'utf8',
  );

  const interrupted = await listInputRefFiles({
    workspaceRoot,
    config: TEST_STORE,
  });
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.state, 'interrupted');
  assert.equal(interrupted[0]?.claimId, claimId);

  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref,
      action: 'retry',
      claimId,
      config: TEST_STORE,
    }),
    { ok: true, disposition: 'pending' },
  );
  const pending = await readInputRefFilePath({
    workspaceRoot,
    ref,
    config: TEST_STORE,
  });
  assert.equal(pending.ok, true);
  if (!pending.ok) {
    assert.fail('expected the interrupted ref to return to pending');
  }
  assert.equal(await readFile(pending.path, 'utf8'), 'recover me');

  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref,
      action: 'release',
      config: TEST_STORE,
    }),
    { ok: true, disposition: 'released' },
  );
  assert.deepEqual(
    await listInputRefFiles({ workspaceRoot, config: TEST_STORE }),
    [],
  );
});

void test('failed input streams leave no pending or claimed file', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-input-ref-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const input = Readable.from(
    (async function* () {
      yield 'partial';
      throw new Error('stream failed');
    })(),
  );
  await assert.rejects(
    writeInputRefFileFromStream({ workspaceRoot, input, config: TEST_STORE }),
    /stream failed/u,
  );

  const directory = join(workspaceRoot, '.geulbat', TEST_STORE.directoryName);
  assert.deepEqual(await readdir(directory), []);
});

void test('input ref reads and claims fail closed on invalid refs, missing files, and double claims', async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-input-ref-guard-'),
  );
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  // A reference without the configured prefix, or with a non-UUID body, is
  // rejected as a bad request before any filesystem access.
  assert.deepEqual(
    await readInputRefFilePath({
      workspaceRoot,
      ref: 'wrong-prefix:body',
      config: TEST_STORE,
    }),
    { ok: false, code: 'bad_request', message: 'invalid prefix' },
  );
  assert.deepEqual(
    await readInputRefFilePath({
      workspaceRoot,
      ref: `${TEST_STORE.refPrefix}not-a-uuid`,
      config: TEST_STORE,
    }),
    { ok: false, code: 'bad_request', message: 'invalid id' },
  );

  // A well-formed reference with no persisted file reads and claims as
  // not_found rather than crashing.
  const absentRef = `${TEST_STORE.refPrefix}${randomUUID()}`;
  assert.deepEqual(
    await readInputRefFilePath({
      workspaceRoot,
      ref: absentRef,
      config: TEST_STORE,
    }),
    { ok: false, code: 'not_found', message: 'not found' },
  );
  assert.deepEqual(
    await claimInputRefFilePath({
      workspaceRoot,
      ref: absentRef,
      config: TEST_STORE,
    }),
    { ok: false, code: 'not_found', message: 'not found' },
  );

  // Once a reference is claimed, both a re-read and a second claim report the
  // in-flight claim as a conflict instead of handing out the bytes twice.
  const written = await writeInputRefFileFromStream({
    workspaceRoot,
    input: Readable.from(['payload']),
    config: TEST_STORE,
  });
  const claimed = await claimInputRefFilePath({
    workspaceRoot,
    ref: written.ref,
    config: TEST_STORE,
  });
  assert.equal(claimed.ok, true);

  assert.deepEqual(
    await readInputRefFilePath({
      workspaceRoot,
      ref: written.ref,
      config: TEST_STORE,
    }),
    { ok: false, code: 'conflict', message: 'already claimed' },
  );
  assert.deepEqual(
    await claimInputRefFilePath({
      workspaceRoot,
      ref: written.ref,
      config: TEST_STORE,
    }),
    { ok: false, code: 'conflict', message: 'already claimed' },
  );

  if (claimed.ok) {
    await deleteInputRefFilePath(claimed.path);
  }
});

void test('input ref recovery rejects invalid refs and claim ids and resolves lone pending state', async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-input-ref-recover-'),
  );
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref: 'wrong-prefix:body',
      action: 'retry',
      config: TEST_STORE,
    }),
    { ok: false, code: 'bad_request', message: 'invalid prefix' },
  );

  const ref = `${TEST_STORE.refPrefix}${randomUUID()}`;
  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref,
      action: 'retry',
      claimId: 'not-a-uuid',
      config: TEST_STORE,
    }),
    {
      ok: false,
      code: 'bad_request',
      message: 'claimId must identify a persisted input ref claim.',
    },
  );

  // Recovering a reference with no persisted file at all is not_found.
  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref,
      action: 'retry',
      config: TEST_STORE,
    }),
    { ok: false, code: 'not_found', message: 'not found' },
  );

  // A lone pending file can be retry-recovered (left pending) or released.
  const written = await writeInputRefFileFromStream({
    workspaceRoot,
    input: Readable.from(['payload']),
    config: TEST_STORE,
  });
  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref: written.ref,
      action: 'retry',
      config: TEST_STORE,
    }),
    { ok: true, disposition: 'pending' },
  );
  assert.deepEqual(
    await recoverInputRefFile({
      workspaceRoot,
      ref: written.ref,
      action: 'release',
      config: TEST_STORE,
    }),
    { ok: true, disposition: 'released' },
  );
  assert.deepEqual(
    await readInputRefFilePath({
      workspaceRoot,
      ref: written.ref,
      config: TEST_STORE,
    }),
    { ok: false, code: 'not_found', message: 'not found' },
  );
});
