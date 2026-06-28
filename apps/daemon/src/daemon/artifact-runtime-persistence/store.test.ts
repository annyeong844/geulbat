import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactId } from '@geulbat/protocol/artifacts';
import type { ProjectId, ThreadId } from '@geulbat/protocol/ids';

import {
  clearArtifactRuntimePersistenceState,
  loadArtifactRuntimePersistenceState,
  saveArtifactRuntimePersistenceState,
} from './store.js';
import {
  classifyRuntimePersistenceError,
  PersistenceBlockedError,
  PersistenceConflictError,
  PersistenceQuotaExceededError,
} from './errors.js';
import { readPersistedRuntimeState } from './stored-state.js';

const PROJECT_ID = 'workspace' as ProjectId;
const THREAD_ID = '00000000-0000-4000-8000-000000000001' as ThreadId;

function createScope(
  artifactId: ArtifactId,
  overrides: Record<string, unknown> = {},
) {
  return {
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    renderer: 'js' as const,
    artifactId,
    persistenceEpoch: 0,
    ...overrides,
  };
}

void test('loadArtifactRuntimePersistenceState returns canonical empty sentinel on first load', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));

  try {
    const result = await loadArtifactRuntimePersistenceState(workspaceRoot, {
      ...createScope('art_demo_js'),
    });

    assert.deepEqual(result, {
      state: null,
      revision: null,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('readPersistedRuntimeState classifies invalid payloads as persistence_conflict', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const statePath = join(workspaceRoot, 'state.json');
  await writeFile(statePath, '{', 'utf8');

  try {
    await assert.rejects(
      () => readPersistedRuntimeState(statePath, createScope('art_demo_js')),
      (error: unknown) =>
        error instanceof PersistenceConflictError &&
        error.code === 'persistence_conflict' &&
        error.cause instanceof Error &&
        error.cause.message === 'invalid runtime persistence payload',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('readPersistedRuntimeState classifies directory state paths as persistence_blocked', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const statePath = join(workspaceRoot, 'state.json');
  await mkdir(statePath);

  try {
    await assert.rejects(
      () => readPersistedRuntimeState(statePath, createScope('art_dir_js')),
      (error: unknown) => {
        assert.ok(error instanceof PersistenceBlockedError);
        assert.equal(error.code, 'persistence_blocked');
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('runtime persistence error classifier maps disk-full failures to persistence_quota_exceeded', () => {
  const diskFull = Object.assign(new Error('no space left on device'), {
    code: 'ENOSPC',
  });

  const error = classifyRuntimePersistenceError(
    'runtime persistence write failed',
    diskFull,
  );

  assert.ok(error instanceof PersistenceQuotaExceededError);
  assert.equal(error.code, 'persistence_quota_exceeded');
  assert.ok(error.cause instanceof Error);
});

void test('runtime persistence save/load/clear follows CAS semantics', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const scope = createScope('art_demo_js');

  try {
    const firstSave = await saveArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
      { count: 1 },
      null,
    );
    assert.equal(typeof firstSave.revision, 'string');

    const loaded = await loadArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
    );
    assert.deepEqual(loaded, {
      state: { count: 1 },
      revision: firstSave.revision,
    });

    await assert.rejects(
      () =>
        saveArtifactRuntimePersistenceState(
          workspaceRoot,
          scope,
          { count: 2 },
          null,
        ),
      (error: unknown) =>
        error instanceof PersistenceConflictError &&
        error.code === 'persistence_conflict',
    );

    const secondSave = await saveArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
      { count: 2 },
      firstSave.revision,
    );
    assert.notEqual(secondSave.revision, firstSave.revision);

    const clear = await clearArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
      secondSave.revision,
    );
    assert.deepEqual(clear, { revision: null });

    const empty = await loadArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
    );
    assert.deepEqual(empty, {
      state: null,
      revision: null,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('concurrent runtime persistence saves allow at most one winner per expectedRevision', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const scope = createScope('art_demo_js');

  try {
    const first = await saveArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
      { count: 1 },
      null,
    );

    const [left, right] = await Promise.allSettled([
      saveArtifactRuntimePersistenceState(
        workspaceRoot,
        scope,
        { count: 2 },
        first.revision,
      ),
      saveArtifactRuntimePersistenceState(
        workspaceRoot,
        scope,
        { count: 3 },
        first.revision,
      ),
    ]);

    const fulfilled = [left, right].filter(
      (result) => result.status === 'fulfilled',
    );
    const rejected = [left, right].filter(
      (result) => result.status === 'rejected',
    );

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0]?.status === 'rejected' &&
        rejected[0].reason instanceof PersistenceConflictError,
      true,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('runtime persistence save/load preserves large states without a hidden byte quota', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const scope = createScope('art_large_js');
  const largeState = {
    // Regression fixture only: this is larger than the retired aggregate byte quota.
    text: 'x'.repeat(300 * 1024),
  };

  try {
    const saved = await saveArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
      largeState,
      null,
    );
    const loaded = await loadArtifactRuntimePersistenceState(
      workspaceRoot,
      scope,
    );
    assert.deepEqual(loaded, {
      state: largeState,
      revision: saved.revision,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
