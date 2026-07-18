import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  claimFileBinaryInputRefPath,
  deleteFileBinaryInputRefPath,
  readFileBinaryInputRefPath,
  writeFileBinaryInputRefFromStream,
} from './binary-input-ref-store.js';

const ROOT_ENV = 'GEULBAT_FILE_BINARY_INPUT_REF_ROOT';

void test('binary input refs use a daemon-local workspace-scoped staging root', async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'geulbat-binary-staging-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-workspace-a-'));
  const otherWorkspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-workspace-b-'),
  );
  const previousRoot = process.env[ROOT_ENV];
  process.env[ROOT_ENV] = stagingRoot;

  try {
    const payload = Buffer.from('daemon-local-binary-input');
    const uploaded = await writeFileBinaryInputRefFromStream({
      workspaceRoot,
      input: Readable.from([payload]),
    });
    const pending = await readFileBinaryInputRefPath({
      workspaceRoot,
      contentRef: uploaded.contentRef,
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) assert.fail('expected the staged ref to be readable');

    const stagingRelativePath = relative(stagingRoot, pending.path);
    assert.equal(isAbsolute(stagingRelativePath), false);
    assert.equal(stagingRelativePath.startsWith('..'), false);
    const workspaceRelativePath = relative(workspaceRoot, pending.path);
    assert.equal(
      isAbsolute(workspaceRelativePath) ||
        workspaceRelativePath.startsWith('..'),
      true,
    );
    if (process.platform !== 'win32') {
      assert.equal((await stat(pending.path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readFile(pending.path), payload);

    assert.deepEqual(
      await readFileBinaryInputRefPath({
        workspaceRoot: otherWorkspaceRoot,
        contentRef: uploaded.contentRef,
      }),
      {
        ok: false,
        code: 'not_found',
        message: 'contentRef was not found.',
      },
    );

    const claimed = await claimFileBinaryInputRefPath({
      workspaceRoot,
      contentRef: uploaded.contentRef,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) assert.fail('expected the staged ref claim to succeed');
    assert.deepEqual(await readFile(claimed.path), payload);
    await deleteFileBinaryInputRefPath(claimed.path);
  } finally {
    if (previousRoot === undefined) delete process.env[ROOT_ENV];
    else process.env[ROOT_ENV] = previousRoot;
    await Promise.all([
      rm(stagingRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
      rm(otherWorkspaceRoot, { recursive: true, force: true }),
    ]);
  }
});
