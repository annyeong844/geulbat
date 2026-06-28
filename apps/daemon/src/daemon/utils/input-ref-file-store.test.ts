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
