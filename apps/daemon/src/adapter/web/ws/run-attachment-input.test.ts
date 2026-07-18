import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  readFileBinaryInputRefPath,
  writeFileBinaryInputRefFromStream,
} from '../../../daemon/files/binary-input-ref-store.js';
import { RUN_ATTACHMENT_WORKSPACE_DIR } from '../../../daemon/agent/run-attachments.js';
import { resolveRunAttachments } from './run-attachment-input.js';

const ROOT_ENV = 'GEULBAT_FILE_BINARY_INPUT_REF_ROOT';

void test('run attachments promote daemon-local refs through a destination-local commit', async (t) => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'geulbat-binary-staging-'));
  const workspaceRoot = await mkdtemp(
    join(process.cwd(), '.geulbat-run-attachment-'),
  );
  const previousRoot = process.env[ROOT_ENV];
  process.env[ROOT_ENV] = stagingRoot;

  try {
    const payload = Buffer.from([0, 1, 2, 3, 4, 5]);
    const uploaded = await writeFileBinaryInputRefFromStream({
      workspaceRoot,
      input: Readable.from([payload]),
    });
    const staged = await readFileBinaryInputRefPath({
      workspaceRoot,
      contentRef: uploaded.contentRef,
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) assert.fail('expected the staged ref to be readable');

    const [stagingDevice, workspaceDevice] = await Promise.all([
      stat(staged.path).then((entry) => entry.dev),
      stat(workspaceRoot).then((entry) => entry.dev),
    ]);
    t.diagnostic(
      stagingDevice === workspaceDevice
        ? 'staging and workspace share a filesystem in this environment'
        : 'cross-filesystem staging boundary exercised',
    );

    const resolved = await resolveRunAttachments(
      [
        {
          contentRef: uploaded.contentRef,
          name: 'opaque.bin',
          mimeType: 'application/octet-stream',
        },
      ],
      { workspaceRoot },
    );
    assert.equal(resolved.ok, true);
    if (!resolved.ok) assert.fail('expected attachment promotion to succeed');

    const attachmentPath = join(
      workspaceRoot,
      RUN_ATTACHMENT_WORKSPACE_DIR,
      'opaque.bin',
    );
    assert.deepEqual(await readFile(attachmentPath), payload);
    assert.equal(
      (await readdir(join(workspaceRoot, RUN_ATTACHMENT_WORKSPACE_DIR))).some(
        (name) => name.endsWith('.tmp'),
      ),
      false,
    );
    assert.deepEqual(
      await readFileBinaryInputRefPath({
        workspaceRoot,
        contentRef: uploaded.contentRef,
      }),
      {
        ok: false,
        code: 'not_found',
        message: 'contentRef was not found.',
      },
    );
  } finally {
    if (previousRoot === undefined) delete process.env[ROOT_ENV];
    else process.env[ROOT_ENV] = previousRoot;
    await Promise.all([
      rm(stagingRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
    ]);
  }
});

void test('run attachment allocation continues past 1000 readable name collisions without overwrite', async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'geulbat-binary-staging-'));
  const workspaceRoot = await mkdtemp(
    join(process.cwd(), '.geulbat-run-attachment-'),
  );
  const previousRoot = process.env[ROOT_ENV];
  process.env[ROOT_ENV] = stagingRoot;

  try {
    const attachmentDir = join(workspaceRoot, RUN_ATTACHMENT_WORKSPACE_DIR);
    await mkdir(attachmentDir, { recursive: true });
    const preserved = Buffer.from('preserved');
    for (let index = 0; index < 1000; index += 1) {
      const name = index === 0 ? 'report.bin' : `report (${index}).bin`;
      await writeFile(join(attachmentDir, name), preserved);
    }

    const payload = Buffer.from([0, 1, 2, 3, 4, 5, 255]);
    const uploaded = await writeFileBinaryInputRefFromStream({
      workspaceRoot,
      input: Readable.from([payload]),
    });
    const resolved = await resolveRunAttachments(
      [
        {
          contentRef: uploaded.contentRef,
          name: 'report.bin',
          mimeType: 'application/octet-stream',
        },
      ],
      { workspaceRoot },
    );

    assert.equal(resolved.ok, true);
    if (!resolved.ok) assert.fail('expected collision allocation to succeed');
    assert.deepEqual(
      await readFile(join(attachmentDir, 'report (1000).bin')),
      payload,
    );
    assert.deepEqual(
      await readFile(join(attachmentDir, 'report.bin')),
      preserved,
    );
    assert.deepEqual(
      await readFile(join(attachmentDir, 'report (999).bin')),
      preserved,
    );
  } finally {
    if (previousRoot === undefined) delete process.env[ROOT_ENV];
    else process.env[ROOT_ENV] = previousRoot;
    await Promise.all([
      rm(stagingRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
    ]);
  }
});

void test('concurrent same-name run attachments reserve distinct files without overwrite', async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'geulbat-binary-staging-'));
  const workspaceRoot = await mkdtemp(
    join(process.cwd(), '.geulbat-run-attachment-'),
  );
  const previousRoot = process.env[ROOT_ENV];
  process.env[ROOT_ENV] = stagingRoot;

  try {
    const firstPayload = Buffer.from([0, 1, 2, 3, 255]);
    const secondPayload = Buffer.from([4, 5, 6, 7, 254]);
    const [firstUpload, secondUpload] = await Promise.all([
      writeFileBinaryInputRefFromStream({
        workspaceRoot,
        input: Readable.from([firstPayload]),
      }),
      writeFileBinaryInputRefFromStream({
        workspaceRoot,
        input: Readable.from([secondPayload]),
      }),
    ]);

    const [firstResult, secondResult] = await Promise.all([
      resolveRunAttachments(
        [
          {
            contentRef: firstUpload.contentRef,
            name: 'race.bin',
            mimeType: 'application/octet-stream',
          },
        ],
        { workspaceRoot },
      ),
      resolveRunAttachments(
        [
          {
            contentRef: secondUpload.contentRef,
            name: 'race.bin',
            mimeType: 'application/octet-stream',
          },
        ],
        { workspaceRoot },
      ),
    ]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    const attachmentDir = join(workspaceRoot, RUN_ATTACHMENT_WORKSPACE_DIR);
    const names = (await readdir(attachmentDir)).sort();
    assert.deepEqual(names, ['race (1).bin', 'race.bin']);
    const contents = await Promise.all(
      names.map((name) => readFile(join(attachmentDir, name))),
    );
    assert.deepEqual(
      new Set(contents.map((content) => content.toString('hex'))),
      new Set([firstPayload.toString('hex'), secondPayload.toString('hex')]),
    );
  } finally {
    if (previousRoot === undefined) delete process.env[ROOT_ENV];
    else process.env[ROOT_ENV] = previousRoot;
    await Promise.all([
      rm(stagingRoot, { recursive: true, force: true }),
      rm(workspaceRoot, { recursive: true, force: true }),
    ]);
  }
});
