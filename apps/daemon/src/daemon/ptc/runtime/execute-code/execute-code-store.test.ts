import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPtcExecuteCodeStore,
  PTC_EXECUTE_CODE_STORE_ENABLED_ENV,
  PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV,
  PTC_EXECUTE_CODE_STORE_MAX_TOTAL_BYTES_ENV,
  PTC_EXECUTE_CODE_STORE_MAX_VALUE_BYTES_ENV,
  resolvePtcExecuteCodeStoreConfigFromEnv,
  type PtcExecuteCodeStore,
  type PtcExecuteCodeStoreExecution,
  type PtcExecuteCodeStoreRuntimeConfig,
} from './execute-code-store.js';
import { createExecuteCodeCallbackRuntime } from './execute-code-batch-runtime.js';

const TEST_STORE_CONFIG = Object.freeze({
  enabled: true,
  maxKeys: 32,
  maxValueBytes: 4_096,
  maxTotalBytes: 32_768,
}) satisfies Extract<PtcExecuteCodeStoreRuntimeConfig, { enabled: true }>;

void test('store config is default-off, strict, and resolves explicit generous defaults', () => {
  assert.equal(resolvePtcExecuteCodeStoreConfigFromEnv({}), undefined);
  assert.deepEqual(
    resolvePtcExecuteCodeStoreConfigFromEnv({
      [PTC_EXECUTE_CODE_STORE_ENABLED_ENV]: 'true',
    }),
    {
      enabled: true,
      maxKeys: 256,
      maxValueBytes: 262_144,
      maxTotalBytes: 4_194_304,
    },
  );
  assert.deepEqual(
    resolvePtcExecuteCodeStoreConfigFromEnv({
      [PTC_EXECUTE_CODE_STORE_ENABLED_ENV]: '1',
      [PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV]: '4',
      [PTC_EXECUTE_CODE_STORE_MAX_VALUE_BYTES_ENV]: '1024',
      [PTC_EXECUTE_CODE_STORE_MAX_TOTAL_BYTES_ENV]: '4096',
    }),
    {
      enabled: true,
      maxKeys: 4,
      maxValueBytes: 1_024,
      maxTotalBytes: 4_096,
    },
  );
  assert.throws(
    () =>
      resolvePtcExecuteCodeStoreConfigFromEnv({
        [PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV]: '4',
      }),
    /limits require GEULBAT_PTC_STORE_ENABLED=true/u,
  );
  for (const invalid of ['', 'yes', '-1', '1.5', '0']) {
    assert.throws(() =>
      resolvePtcExecuteCodeStoreConfigFromEnv(
        invalid === '' || invalid === 'yes'
          ? { [PTC_EXECUTE_CODE_STORE_ENABLED_ENV]: invalid }
          : {
              [PTC_EXECUTE_CODE_STORE_ENABLED_ENV]: 'true',
              [PTC_EXECUTE_CODE_STORE_MAX_KEYS_ENV]: invalid,
            },
      ),
    );
  }
});

void test('store callback kinds fail closed when the store knob is off', async () => {
  const callbackRuntime = createExecuteCodeCallbackRuntime({
    callbackTransportPolicy: {
      maxFrameBytes: 8_192,
      maxOpenConnections: 2,
      maxCallbacks: 4,
      callbackTimeoutMs: 5_000,
      maxResponseBytes: 8_192,
    },
    toolCallbackHandler: async () => ({ ok: true, result: undefined }),
  });
  const result = await callbackRuntime.callbackHandler({
    requestId: 'store-disabled-1',
    kind: 'store_get',
    args: { key: 'note' },
    signal: new AbortController().signal,
    enterLongWait: () => true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, 'StoreDisabled');
    assert.match(result.remediation ?? '', /GEULBAT_PTC_STORE_ENABLED/u);
  }
});

void test('store snapshots eagerly, reads its own writes, persists across restart, and isolates threads', async () => {
  await withStoreRoot(async (rootDir) => {
    const firstStore = createPtcExecuteCodeStore({
      rootDir,
      config: TEST_STORE_CONFIG,
    });
    const initial = await begin(firstStore, 'thread-a', 'exec-initial');
    assert.equal(initial.get('note').ok, true);
    assert.deepEqual(initial.set('note', { version: 1 }), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(initial.get('note'), {
      ok: true,
      value: { version: 1 },
    });
    assert.deepEqual(await initial.commit(), {
      ok: true,
      value: { committedKeys: ['note'], revisions: { note: 1 } },
    });

    const stale = await begin(firstStore, 'thread-a', 'exec-stale');
    const concurrent = await begin(firstStore, 'thread-a', 'exec-concurrent');
    assert.deepEqual(concurrent.set('note', { version: 2 }), {
      ok: true,
      value: undefined,
    });
    assert.equal((await concurrent.commit()).ok, true);
    assert.deepEqual(stale.get('note'), {
      ok: true,
      value: { version: 1 },
    });

    const restartedStore = createPtcExecuteCodeStore({
      rootDir,
      config: TEST_STORE_CONFIG,
    });
    const afterRestart = await begin(
      restartedStore,
      'thread-a',
      'exec-after-restart',
    );
    assert.deepEqual(afterRestart.get('note'), {
      ok: true,
      value: { version: 2 },
    });
    assert.deepEqual(
      (await begin(restartedStore, 'thread-b', 'exec-other-thread')).get(
        'note',
      ),
      { ok: true, value: undefined },
    );
  });
});

void test('same-key conflict rejects the whole write set while disjoint commits both succeed', async () => {
  await withStoreRoot(async (rootDir) => {
    const store = createPtcExecuteCodeStore({
      rootDir,
      config: TEST_STORE_CONFIG,
    });
    const seed = await begin(store, 'thread-conflict', 'exec-seed');
    assert.equal(seed.set('shared', 1).ok, true);
    assert.equal((await seed.commit()).ok, true);

    const stale = await begin(store, 'thread-conflict', 'exec-stale');
    const winner = await begin(store, 'thread-conflict', 'exec-winner');
    assert.equal(stale.set('shared', 2).ok, true);
    assert.equal(stale.set('stale-only', true).ok, true);
    assert.equal(winner.set('shared', 3).ok, true);
    assert.equal((await winner.commit()).ok, true);

    const conflict = await stale.commit();
    assert.equal(conflict.ok, false);
    if (conflict.ok) {
      return;
    }
    assert.equal(conflict.error.errorCode, 'StoreCommitConflict');
    assert.match(
      conflict.error.remediation,
      /geulbat\.store\.get\("shared"\)/u,
    );
    assert.deepEqual(conflict.error.details, {
      conflicts: [
        {
          key: 'shared',
          baseRevision: 1,
          currentRevision: 2,
          lastWriterExecutionId: 'exec-winner',
        },
      ],
    });

    const afterConflict = await begin(
      store,
      'thread-conflict',
      'exec-check-atomic',
    );
    assert.deepEqual(afterConflict.get('shared'), { ok: true, value: 3 });
    assert.deepEqual(afterConflict.get('stale-only'), {
      ok: true,
      value: undefined,
    });

    const left = await begin(store, 'thread-conflict', 'exec-left');
    const right = await begin(store, 'thread-conflict', 'exec-right');
    assert.equal(left.set('left', 'L').ok, true);
    assert.equal(right.set('right', 'R').ok, true);
    const [leftCommit, rightCommit] = await Promise.all([
      left.commit(),
      right.commit(),
    ]);
    assert.equal(leftCommit.ok, true);
    assert.equal(rightCommit.ok, true);
  });
});

void test('store rejects invalid keys, non-round-trip values, unsupported merge policies, and configured limits', async () => {
  await withStoreRoot(async (rootDir) => {
    const store = createPtcExecuteCodeStore({
      rootDir,
      config: {
        enabled: true,
        maxKeys: 2,
        maxValueBytes: 8,
        maxTotalBytes: 12,
      },
    });
    const execution = await begin(store, 'thread-limits', 'exec-limits');
    assertStoreError(execution.set('', 1), 'StoreInvalidKey');
    assertStoreError(execution.set('x'.repeat(513), 1), 'StoreInvalidKey');
    assertStoreError(
      execution.set('bad', Number.POSITIVE_INFINITY),
      'StoreValueNotSerializable',
    );
    assertStoreError(execution.set('bad', 1n), 'StoreValueNotSerializable');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assertStoreError(
      execution.set('bad', circular),
      'StoreValueNotSerializable',
    );
    assertStoreError(
      execution.set('bad', { omitted: undefined }),
      'StoreValueNotSerializable',
    );
    assertStoreError(
      execution.set('bad', 1, { merge: 'numeric-add' }),
      'StoreMergePolicyUnsupported',
    );
    assertStoreError(
      execution.set('bad', 1, { merge: 'conflict', extra: true }),
      'StoreOptionsInvalid',
    );
    assertStoreError(
      execution.set('too-large', '1234567'),
      'StoreMaxValueBytesExceeded',
    );

    assert.equal(execution.set('one', '1234').ok, true);
    assert.equal(execution.set('two', '12').ok, true);
    assertStoreError(execution.set('three', 'x'), 'StoreMaxKeysExceeded');
    assert.equal((await execution.commit()).ok, true);

    const totalLimit = await begin(store, 'thread-limits', 'exec-total-limit');
    assertStoreError(
      totalLimit.set('two', '123456'),
      'StoreMaxTotalBytesExceeded',
    );
  });
});

void test('thread path hashing and per-thread serialization prevent path escape and lost updates', async () => {
  await withStoreRoot(async (rootDir) => {
    const store = createPtcExecuteCodeStore({
      rootDir,
      config: TEST_STORE_CONFIG,
    });
    const hostileThreadId = `../outside/\\:${'very-long'.repeat(200)}`;
    const executions = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const execution = await begin(
          store,
          hostileThreadId,
          `exec-race-${index}`,
        );
        assert.equal(execution.set('shared', index).ok, true);
        return execution;
      }),
    );
    const commits = await Promise.all(
      executions.map(async (execution) => await execution.commit()),
    );
    assert.equal(commits.filter((commit) => commit.ok).length, 1);
    assert.equal(
      commits.filter(
        (commit) =>
          !commit.ok && commit.error.errorCode === 'StoreCommitConflict',
      ).length,
      15,
    );

    const files = await readdir(rootDir);
    assert.equal(files.length, 1);
    assert.match(files[0] ?? '', /^thread-[0-9a-f]{64}\.json$/u);
    assert.equal((files[0] ?? '').includes('outside'), false);
    const persisted = JSON.parse(
      await readFile(join(rootDir, files[0] ?? ''), 'utf8'),
    ) as { entries?: unknown[] };
    assert.equal(Array.isArray(persisted.entries), true);
    assert.equal(persisted.entries?.length, 1);

    const discarded = await begin(store, hostileThreadId, 'exec-discard');
    assert.equal(discarded.set('a', 1).ok, true);
    assert.equal(discarded.set('a', 2).ok, true);
    assert.deepEqual(discarded.discard(), { discardedWrites: 2 });
  });
});

async function begin(
  store: PtcExecuteCodeStore,
  threadId: string,
  executionId: string,
): Promise<PtcExecuteCodeStoreExecution> {
  const result = await store.beginExecution({ threadId, executionId });
  if (!result.ok) {
    assert.fail(result.error.message);
  }
  assert.equal(result.ok, true);
  return result.value;
}

function assertStoreError(
  result: ReturnType<PtcExecuteCodeStoreExecution['set']>,
  errorCode: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.errorCode, errorCode);
    assert.ok(result.error.remediation.length > 0);
  }
}

async function withStoreRoot(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'geulbat-ptc-store-'));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}
