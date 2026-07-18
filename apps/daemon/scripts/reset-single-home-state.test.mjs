import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applySingleHomeLegacyStateReset,
  planSingleHomeLegacyStateReset,
} from './reset-single-home-state.mjs';

void test('single-home reset removes allowlisted internal state and preserves user files and auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-single-home-reset-'));
  try {
    await mkdir(join(root, '.geulbat'), { recursive: true });
    await writeFile(
      join(root, '.geulbat', 'projects.json'),
      `${JSON.stringify({
        version: 1,
        projects: [{ projectId: 'workspace', label: 'Workspace' }],
      })}\n`,
    );
    await writeFile(join(root, '.geulbat', 'dev-auth-token'), 'secret');
    await mkdir(join(root, '.geulbat', 'dev'), { recursive: true });
    await writeFile(join(root, '.geulbat', 'dev', 'daemon.mjs'), 'keep me');
    await mkdir(join(root, '.geulbat', 'sessions'), { recursive: true });
    await mkdir(join(root, 'workspace', '.geulbat', 'sessions'), {
      recursive: true,
    });
    await mkdir(join(root, 'workspace', '.geulbat', 'tool-outputs'), {
      recursive: true,
    });
    await writeFile(join(root, 'workspace', 'manuscript.md'), 'keep me');

    const plan = await planSingleHomeLegacyStateReset({ repoRoot: root });
    assert.equal(plan.daemonLockPresent, false);
    assert.deepEqual(plan.unknownEntries, []);
    assert.deepEqual(
      plan.targets.map((target) => target.relativePath),
      [
        '.geulbat/projects.json',
        '.geulbat/sessions',
        'workspace/.geulbat/sessions',
        'workspace/.geulbat/tool-outputs',
      ],
    );

    const result = await applySingleHomeLegacyStateReset({ repoRoot: root });
    assert.deepEqual(result.removed, [
      '.geulbat/projects.json',
      '.geulbat/sessions',
      'workspace/.geulbat/sessions',
      'workspace/.geulbat/tool-outputs',
    ]);
    assert.equal(
      await readFile(join(root, 'workspace', 'manuscript.md'), 'utf8'),
      'keep me',
    );
    assert.equal(
      await readFile(join(root, '.geulbat', 'dev-auth-token'), 'utf8'),
      'secret',
    );
    assert.equal(
      await readFile(join(root, '.geulbat', 'dev', 'daemon.mjs'), 'utf8'),
      'keep me',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('single-home reset refuses a live daemon lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-single-home-reset-'));
  try {
    await mkdir(join(root, '.geulbat'), { recursive: true });
    await writeFile(join(root, '.geulbat', 'daemon-admission-lock.json'), '{}');
    await assert.rejects(
      applySingleHomeLegacyStateReset({ repoRoot: root }),
      /stop the daemon/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('single-home reset refuses unknown internal state and symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-single-home-reset-'));
  try {
    await mkdir(join(root, 'workspace', '.geulbat', 'unknown-family'), {
      recursive: true,
    });
    await assert.rejects(
      applySingleHomeLegacyStateReset({ repoRoot: root }),
      /unknown \.geulbat entries/u,
    );

    await rm(join(root, 'workspace', '.geulbat', 'unknown-family'), {
      recursive: true,
    });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(
      outside,
      join(root, 'workspace', '.geulbat', 'sessions'),
      'dir',
    );
    await assert.rejects(
      applySingleHomeLegacyStateReset({ repoRoot: root }),
      /symlink target/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('single-home reset CLI dry-run omits the absolute repo root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-single-home-reset-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('./reset-single-home-state.mjs', import.meta.url),
        ),
        '--root',
        root,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(root), false);
    assert.deepEqual(JSON.parse(result.stdout), {
      daemonLockPresent: false,
      projectIds: ['workspace'],
      targets: [],
      unknownEntries: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
