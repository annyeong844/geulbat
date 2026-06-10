import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WorkspaceAdmissionLockConflictError,
  acquireWorkspaceAdmissionLock,
  getWorkspaceAdmissionLockPath,
} from './workspace-admission-lock.js';

void test('workspace admission lock rejects a second live owner for the same root', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const first = await acquireWorkspaceAdmissionLock({
    now: () => new Date('2026-05-02T00:00:00.000Z'),
    ownerId: 'owner-one',
    workspaceRoot,
  });

  try {
    await assert.rejects(
      () =>
        acquireWorkspaceAdmissionLock({
          now: () => new Date('2026-05-02T00:00:01.000Z'),
          ownerId: 'owner-two',
          workspaceRoot,
        }),
      (error: unknown) =>
        error instanceof WorkspaceAdmissionLockConflictError &&
        error.owner?.ownerId === 'owner-one' &&
        error.lockPath === first.lockPath,
    );
  } finally {
    await first.release();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('workspace admission lock recovers a stale same-host owner', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const lockPath = getWorkspaceAdmissionLockPath(workspaceRoot);
  const staleOwner = {
    version: 1,
    acquiredAt: '2026-05-01T00:00:00.000Z',
    hostname: 'test-host',
    ownerId: 'stale-owner',
    pid: 1234,
    workspaceRoot,
  };
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(staleOwner, null, 2)}\n`, 'utf8');

  const lock = await acquireWorkspaceAdmissionLock({
    hostname: 'test-host',
    isProcessAlive: () => false,
    now: () => new Date('2026-05-02T00:00:00.000Z'),
    ownerId: 'fresh-owner',
    pid: 5678,
    workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('workspace admission lock release does not remove a replacement owner', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-admission-'));
  const lockPath = getWorkspaceAdmissionLockPath(workspaceRoot);
  const first = await acquireWorkspaceAdmissionLock({
    ownerId: 'owner-one',
    workspaceRoot,
  });
  const replacementOwner = {
    version: 1,
    acquiredAt: '2026-05-02T00:00:00.000Z',
    hostname: 'test-host',
    ownerId: 'owner-two',
    pid: 5678,
    workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
