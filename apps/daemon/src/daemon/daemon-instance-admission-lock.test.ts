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
  readDaemonInstanceAdmissionLockOwner,
} from './daemon-instance-admission-lock.js';

/**
 * 포트가 유동이면 "지금 도는 데몬은 어디 있나"를 사람이 알 수 없다. 그 답을
 * 이미 존재하는 admission lock이 나른다: 소유권을 기록하는 파일이 소유자의
 * 접속 지점도 함께 기록한다. lock은 listen 전에 잡히므로 포트는 나중에 붙는다.
 */
void test('the admission lock records the listening port after the server binds', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-port-'));
  const lock = await acquireDaemonInstanceAdmissionLock({
    ownerId: 'port-owner',
    stateRoot,
  });

  try {
    assert.equal(lock.owner.port, undefined);

    await lock.recordListeningPort(41234);

    const discovered = await readDaemonInstanceAdmissionLockOwner(stateRoot);
    assert.equal(discovered?.port, 41234);
    assert.equal(discovered?.ownerId, 'port-owner');
  } finally {
    await lock.release();
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('discovering the listening port reports nothing once the daemon released the lock', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-gone-'));
  const lock = await acquireDaemonInstanceAdmissionLock({
    ownerId: 'released-owner',
    stateRoot,
  });
  await lock.recordListeningPort(41235);
  await lock.release();

  try {
    // 죽은 데몬의 포트를 살아있는 것처럼 돌려주면 CLI가 없는 주소를 연다.
    assert.equal(await readDaemonInstanceAdmissionLockOwner(stateRoot), null);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('a superseded owner cannot overwrite the recorded port', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-stale-'));
  const lock = await acquireDaemonInstanceAdmissionLock({
    ownerId: 'live-owner',
    stateRoot,
  });

  try {
    await lock.recordListeningPort(41236);
    // 같은 경로를 다른 소유자가 잡은 뒤 이전 소유자가 늦게 기록하는 경우.
    await writeFile(
      lock.lockPath,
      `${JSON.stringify({ ...lock.owner, ownerId: 'other-owner', port: 41237 }, null, 2)}\n`,
      'utf8',
    );

    await assert.rejects(() => lock.recordListeningPort(41238));
    assert.equal(
      (await readDaemonInstanceAdmissionLockOwner(stateRoot))?.port,
      41237,
    );
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

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
