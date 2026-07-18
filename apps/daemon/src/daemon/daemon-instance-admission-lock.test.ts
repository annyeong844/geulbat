import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DaemonInstanceAdmissionLockConflictError,
  acquireDaemonInstanceAdmissionLock,
  getDaemonInstanceAdmissionLockPath,
} from './daemon-instance-admission-lock.js';

void test('daemon instance admission lock creates a missing state root on first launch', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-fresh-'));
  const stateRoot = join(fixtureRoot, 'new', 'state-root');
  const lock = await acquireDaemonInstanceAdmissionLock({
    ownerId: 'first-launch-owner',
    stateRoot,
  });

  try {
    assert.equal(lock.owner.stateRoot, await realpath(stateRoot));
    assert.deepEqual(
      JSON.parse(await readFile(lock.lockPath, 'utf8')),
      lock.owner,
    );
  } finally {
    await lock.release();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('daemon instance admission lock rejects a second live owner for the same root', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const first = await acquireDaemonInstanceAdmissionLock({
    now: () => new Date('2026-05-02T00:00:00.000Z'),
    ownerId: 'owner-one',
    stateRoot,
  });

  try {
    await assert.rejects(
      () =>
        acquireDaemonInstanceAdmissionLock({
          now: () => new Date('2026-05-02T00:00:01.000Z'),
          ownerId: 'owner-two',
          stateRoot,
        }),
      (error: unknown) =>
        error instanceof DaemonInstanceAdmissionLockConflictError &&
        error.owner?.ownerId === 'owner-one' &&
        error.lockPath === first.lockPath,
    );
  } finally {
    await first.release();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon instance admission lock publishes one complete owner under concurrent acquisition', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const lockPath = getDaemonInstanceAdmissionLockPath(stateRoot);
  const attempts = Array.from({ length: 8 }, (_, index) =>
    acquireDaemonInstanceAdmissionLock({
      now: () => new Date('2026-05-02T00:00:00.000Z'),
      ownerId: `owner-${index}`,
      stateRoot,
    }),
  );
  const settled = await Promise.allSettled(attempts);
  const acquired = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );

  try {
    assert.equal(acquired.length, 1);
    const winner = acquired[0];
    assert.notEqual(winner, undefined);
    if (winner === undefined) {
      assert.fail('expected one admission lock owner');
    }

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        continue;
      }
      const reason: unknown = result.reason;
      assert.equal(
        reason instanceof DaemonInstanceAdmissionLockConflictError,
        true,
      );
      if (reason instanceof DaemonInstanceAdmissionLockConflictError) {
        assert.notEqual(reason.owner, null);
        assert.equal(reason.owner?.ownerId, winner.owner.ownerId);
      }
    }

    const storedOwner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.deepEqual(storedOwner, winner.owner);
    assert.equal(
      await readFile(lockPath, 'utf8'),
      `${JSON.stringify(winner.owner, null, 2)}\n`,
    );
    assert.deepEqual(await readdir(dirname(lockPath)), [basename(lockPath)]);
  } finally {
    await Promise.all(acquired.map((lock) => lock.release()));
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon instance admission lock recovers a stale same-host owner', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const lockPath = getDaemonInstanceAdmissionLockPath(stateRoot);
  const staleOwner = {
    version: 2,
    acquiredAt: '2026-05-01T00:00:00.000Z',
    hostname: 'test-host',
    ownerId: 'stale-owner',
    pid: 1234,
    stateRoot,
  };
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(staleOwner, null, 2)}\n`, 'utf8');

  const lock = await acquireDaemonInstanceAdmissionLock({
    hostname: 'test-host',
    isProcessAlive: () => false,
    now: () => new Date('2026-05-02T00:00:00.000Z'),
    ownerId: 'fresh-owner',
    pid: 5678,
    stateRoot,
  });

  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
      ownerId: string;
      pid: number;
    };
    assert.equal(owner.ownerId, 'fresh-owner');
    assert.equal(owner.pid, 5678);
  } finally {
    await lock.release();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon instance admission lock release does not remove a replacement owner', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const lockPath = getDaemonInstanceAdmissionLockPath(stateRoot);
  const first = await acquireDaemonInstanceAdmissionLock({
    ownerId: 'owner-one',
    stateRoot,
  });
  const replacementOwner = {
    version: 2,
    acquiredAt: '2026-05-02T00:00:00.000Z',
    hostname: 'test-host',
    ownerId: 'owner-two',
    pid: 5678,
    stateRoot,
  };
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify(replacementOwner, null, 2)}\n`,
    'utf8',
  );

  try {
    await first.release();

    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
      ownerId: string;
    };
    assert.equal(owner.ownerId, 'owner-two');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon instance admission lock keeps an invalid legacy owner fail-closed', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const lockPath = getDaemonInstanceAdmissionLockPath(stateRoot);
  const invalidOwner = '{"version":1';
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, invalidOwner, 'utf8');

  try {
    await assert.rejects(
      () =>
        acquireDaemonInstanceAdmissionLock({
          ownerId: 'replacement-owner',
          stateRoot,
        }),
      (error: unknown) =>
        error instanceof DaemonInstanceAdmissionLockConflictError &&
        error.owner === null,
    );
    assert.equal(await readFile(lockPath, 'utf8'), invalidOwner);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
