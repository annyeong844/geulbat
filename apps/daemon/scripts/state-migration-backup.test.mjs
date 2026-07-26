import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createStateMigrationBackup,
  measureStateMigrationBaseline,
  restoreStateMigrationBackup,
  verifyStateMigrationBackup,
} from './state-migration-backup.mjs';

const TARGET = '.geulbat/sessions';

void test('state migration backup restores the selected tree byte for byte', async () => {
  const fixture = await createFixture();
  try {
    const expectedIndex = Buffer.from('{"version":1}\n', 'utf8');
    const expectedTranscript = Buffer.from([
      0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0xff, 0x00, 0x7d, 0x0a,
    ]);
    await writeFixtureFiles(fixture.stateRoot, {
      index: expectedIndex,
      transcript: expectedTranscript,
    });

    const backup = await createStateMigrationBackup({
      stateRoot: fixture.stateRoot,
      backupRoot: fixture.backupRoot,
      targetPaths: [TARGET],
    });
    assert.deepEqual(backup.targets, [TARGET]);
    assert.equal(backup.fileCount, 2);
    assert.equal(backup.directoryCount, 2);
    assert.equal(
      backup.byteLength,
      expectedIndex.byteLength + expectedTranscript.byteLength,
    );
    assert.match(backup.treeSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      await verifyStateMigrationBackup({ backupRoot: fixture.backupRoot }),
      backup,
    );

    await writeFile(
      join(fixture.stateRoot, TARGET, 'thread.jsonl'),
      Buffer.from('changed after backup', 'utf8'),
    );
    const restored = await restoreStateMigrationBackup({
      backupRoot: fixture.backupRoot,
      destinationStateRoot: fixture.restoreRoot,
    });
    assert.deepEqual(restored, backup);
    assert.deepEqual(
      await readFile(join(fixture.restoreRoot, TARGET, 'index.json')),
      expectedIndex,
    );
    assert.deepEqual(
      await readFile(join(fixture.restoreRoot, TARGET, 'thread.jsonl')),
      expectedTranscript,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration backup rejects tampered payload before restore', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot);
    await createStateMigrationBackup({
      stateRoot: fixture.stateRoot,
      backupRoot: fixture.backupRoot,
      targetPaths: [TARGET],
    });
    await writeFile(
      join(fixture.backupRoot, 'payload', TARGET, 'index.json'),
      'tampered',
    );

    await assert.rejects(
      verifyStateMigrationBackup({ backupRoot: fixture.backupRoot }),
      /backup payload changed/u,
    );
    await assert.rejects(
      restoreStateMigrationBackup({
        backupRoot: fixture.backupRoot,
        destinationStateRoot: fixture.restoreRoot,
      }),
      /backup payload changed/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration backup rejects symlinks and a live daemon lock', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot);
    const outside = join(fixture.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(fixture.stateRoot, TARGET, 'linked'), 'dir');
    await assert.rejects(
      createStateMigrationBackup({
        stateRoot: fixture.stateRoot,
        backupRoot: fixture.backupRoot,
        targetPaths: [TARGET],
      }),
      /symlink detected/u,
    );

    await rm(join(fixture.stateRoot, TARGET, 'linked'));
    await writeFile(
      join(fixture.stateRoot, '.geulbat', 'daemon-admission-lock.json'),
      '{}',
    );
    await assert.rejects(
      createStateMigrationBackup({
        stateRoot: fixture.stateRoot,
        backupRoot: fixture.backupRoot,
        targetPaths: [TARGET],
      }),
      /stop the daemon/u,
    );
    await assert.rejects(
      measureStateMigrationBaseline({
        stateRoot: fixture.stateRoot,
        targetPaths: [TARGET],
      }),
      /stop the daemon/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration baseline records stable JSONL entry counts without content', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot, {
      transcript: Buffer.from(
        '{"entry":"one"}\n\n  {"entry":"two"}\r\n',
        'utf8',
      ),
    });
    const baseline = await measureStateMigrationBaseline({
      stateRoot: fixture.stateRoot,
      targetPaths: [TARGET],
    });

    assert.deepEqual(baseline.targets, [TARGET]);
    assert.equal(baseline.jsonlFileCount, 1);
    assert.equal(baseline.jsonlEntryCount, 2);
    assert.equal(baseline.fileCount, 2);
    assert.match(baseline.treeSha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(baseline).includes('entry'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration baseline rejects malformed JSONL', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot, {
      transcript: Buffer.from('{"entry":"valid"}\nnot-json\n', 'utf8'),
    });
    await assert.rejects(
      measureStateMigrationBaseline({
        stateRoot: fixture.stateRoot,
        targetPaths: [TARGET],
      }),
      /invalid JSONL record/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration backup refuses nested roots without touching source state', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot);
    const nestedBackupRoot = join(
      fixture.stateRoot,
      'must-not-be-created',
      'backup',
    );
    await assert.rejects(
      createStateMigrationBackup({
        stateRoot: fixture.stateRoot,
        backupRoot: nestedBackupRoot,
        targetPaths: [TARGET],
      }),
      /must be disjoint/u,
    );
    await assert.rejects(
      lstat(join(fixture.stateRoot, 'must-not-be-created')),
      (error) => error?.code === 'ENOENT',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration restore never overwrites an existing target', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot);
    await createStateMigrationBackup({
      stateRoot: fixture.stateRoot,
      backupRoot: fixture.backupRoot,
      targetPaths: [TARGET],
    });
    await mkdir(join(fixture.restoreRoot, TARGET), { recursive: true });
    await writeFile(
      join(fixture.restoreRoot, TARGET, 'keep.txt'),
      'do not overwrite',
    );

    await assert.rejects(
      restoreStateMigrationBackup({
        backupRoot: fixture.backupRoot,
        destinationStateRoot: fixture.restoreRoot,
      }),
      /target already exists/u,
    );
    assert.equal(
      await readFile(join(fixture.restoreRoot, TARGET, 'keep.txt'), 'utf8'),
      'do not overwrite',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration backup CLI emits only portable evidence', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./state-migration-backup.mjs', import.meta.url)),
        '--state-root',
        fixture.stateRoot,
        '--backup-root',
        fixture.backupRoot,
        '--restore-root',
        fixture.restoreRoot,
        '--target',
        TARGET,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(fixture.root), false);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.backup, output.verified);
    assert.deepEqual(output.backup, output.restored);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('state migration baseline CLI requires no writable destination', async () => {
  const fixture = await createFixture();
  try {
    await writeFixtureFiles(fixture.stateRoot, {
      transcript: Buffer.from('{"entry":"one"}\n{"entry":"two"}\n', 'utf8'),
    });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./state-migration-backup.mjs', import.meta.url)),
        '--measure-only',
        '--state-root',
        fixture.stateRoot,
        '--target',
        TARGET,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(fixture.root), false);
    assert.deepEqual(JSON.parse(result.stdout).baseline.jsonlEntryCount, 2);
    await assert.rejects(lstat(fixture.backupRoot), (error) =>
      Boolean(error?.code === 'ENOENT'),
    );
    await assert.rejects(lstat(fixture.restoreRoot), (error) =>
      Boolean(error?.code === 'ENOENT'),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-state-migration-'));
  const stateRoot = join(root, 'state');
  await mkdir(stateRoot);
  return {
    root,
    stateRoot,
    backupRoot: join(root, 'backup'),
    restoreRoot: join(root, 'restore'),
  };
}

async function writeFixtureFiles(
  stateRoot,
  {
    index = Buffer.from('{"version":1}\n', 'utf8'),
    transcript = Buffer.from('{"entry":"one"}\n', 'utf8'),
  } = {},
) {
  await mkdir(join(stateRoot, TARGET, 'empty'), { recursive: true });
  await writeFile(join(stateRoot, TARGET, 'index.json'), index);
  await writeFile(join(stateRoot, TARGET, 'thread.jsonl'), transcript);
}
