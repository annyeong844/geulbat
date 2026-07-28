import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256Digest } from '@geulbat/content-identity/sha256';

import {
  DaemonRuntimeStateStoreError,
  createDaemonRuntimeStateStore,
  resolveDaemonRuntimeStateDatabasePath,
} from './runtime-state-store.js';
import type {
  BackgroundChildResult,
  SubagentLaunchRequestInput,
} from './subagent-runtime-contracts.js';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import type { SubagentLaunchPriorityClass } from '@geulbat/protocol/run-events';
import { testRunId } from '../test-support/run-id.js';
import { testThreadId } from '../test-support/thread-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../test-support/subagent-model-routing.js';

void test('runtime-state database path stays below the canonical Home state root', () => {
  assert.equal(
    resolveDaemonRuntimeStateDatabasePath('/state/geulbat'),
    join('/state/geulbat', '.geulbat', 'runtime-state.sqlite3'),
  );
  assert.throws(
    () => resolveDaemonRuntimeStateDatabasePath('relative/state'),
    /home root must be an absolute path/u,
  );
});

void test('runtime-state store configures a real SQLite file for durable daemon state', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    assert.equal(store.databasePath, databasePath);
    assert.equal((await stat(databasePath)).isFile(), true);
    assert.deepEqual(store.readDiagnostics(), {
      foreignKeysEnabled: true,
      journalMode: 'wal',
      schemaVersion: 17,
      startupHealth: 'ok',
      startupMigration: {
        backupCreated: false,
        fromVersion: 0,
        toVersion: 17,
      },
      synchronousMode: 'full',
    });

    store.close();
    store.close();
    assert.throws(
      () => store.readDiagnostics(),
      /runtime-state store is closed/u,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store persists MCP re-adoption coordinates without a read offset', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-mcp-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    assert.equal(store.readMcpSessionCoordinate('server-one'), undefined);
    store.persistMcpSessionCoordinate({
      serverId: 'server-one',
      outputRef: 'command-output-one',
    });
    assert.deepEqual(store.readMcpSessionCoordinate('server-one'), {
      serverId: 'server-one',
      outputRef: 'command-output-one',
    });
    store.persistMcpSessionCoordinate({
      serverId: 'server-one',
      outputRef: 'command-output-two',
    });
    store.close();

    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    assert.deepEqual(store.readMcpSessionCoordinate('server-one'), {
      serverId: 'server-one',
      outputRef: 'command-output-two',
    });

    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      const columns = database
        .prepare('PRAGMA table_info(mcp_session_coordinates)')
        .all()
        .map((row) => row['name']);
      assert.deepEqual(columns, ['server_id', 'output_ref']);
    } finally {
      database.close();
    }

    store.deleteMcpSessionCoordinate('server-one');
    assert.equal(store.readMcpSessionCoordinate('server-one'), undefined);
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store persists PTC cell re-adoption coordinates without callback secrets', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-ptc-cell-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const coordinate = {
    stateRoot: homeStateRoot,
    threadId: 'thread-ptc-cell',
    cellId: 'ptc_cell_durable' as const,
    createdAtMs: 1_721_000_000_000,
    effectiveTimeoutMs: 60_000,
    orphanReapAtMs: 1_721_000_120_000,
    processOutputRef: 'command-output-cell-one',
    callbackOutputRef: 'command-output-callback-one',
    trustContextId: 'ptc_lab_execute_code_batch_node_v1',
    containerId: 'ptc-container-one',
    maxBufferedBytesPerStream: 2 * 1024 * 1024,
    callbackToolNames: ['read_file', 'search_files'],
    storeCallbacksEnabled: false,
  };

  try {
    assert.deepEqual(store.listPtcExecuteCodeCellCoordinates(), []);
    await store.persistPtcExecuteCodeCellCoordinate(coordinate);
    assert.deepEqual(store.listPtcExecuteCodeCellCoordinates(), [coordinate]);
    await store.persistPtcExecuteCodeCellCoordinate({
      ...coordinate,
      processOutputRef: 'command-output-cell-two',
      callbackOutputRef: 'command-output-callback-two',
    });
    const execDelivery = {
      threadId: coordinate.threadId,
      runId: 'run-ptc-exec',
      callId: 'call-ptc-exec',
      cellId: coordinate.cellId,
      stdout: 'initial output\n',
      stderr: '',
      durationMs: 25,
      toolCallbackCount: 1,
      outputReadOffsets: {
        stdoutBytes: 15,
        stderrBytes: 0,
      },
    };
    assert.throws(
      () =>
        store.persistPtcExecuteCodeRunningExecDelivery?.({
          ...execDelivery,
          cellId: 'ptc_cell_missing',
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation' &&
        error.cause instanceof Error &&
        /matching live cell coordinate/u.test(error.cause.message),
    );
    store.persistPtcExecuteCodeRunningExecDelivery?.(execDelivery);
    assert.deepEqual(
      store.readPtcExecuteCodeRunningExecDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      execDelivery,
    );
    const delivery = {
      threadId: coordinate.threadId,
      runId: 'run-ptc-wait',
      callId: 'call-ptc-wait',
      cellId: coordinate.cellId,
      stdout: 'durable partial output\n',
      stderr: '',
      outputReadOffsets: {
        stdoutBytes: 23,
        stderrBytes: 0,
      },
    };
    assert.throws(
      () =>
        store.persistPtcExecuteCodeRunningWaitDelivery?.({
          ...delivery,
          cellId: 'ptc_cell_missing',
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation' &&
        error.cause instanceof Error &&
        /matching live cell coordinate/u.test(error.cause.message),
    );
    assert.equal(
      store.readPtcExecuteCodeRunningWaitDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      undefined,
    );
    store.persistPtcExecuteCodeRunningWaitDelivery?.(delivery);
    assert.deepEqual(
      store.readPtcExecuteCodeRunningWaitDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      delivery,
    );
    assert.deepEqual(
      store.readPtcExecuteCodeRunningExecDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      execDelivery,
    );
    store.close();

    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    assert.deepEqual(store.listPtcExecuteCodeCellCoordinates(), [
      {
        ...coordinate,
        processOutputRef: 'command-output-cell-two',
        callbackOutputRef: 'command-output-callback-two',
        outputReadOffsets: delivery.outputReadOffsets,
      },
    ]);
    assert.deepEqual(
      store.readPtcExecuteCodeRunningWaitDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      delivery,
    );

    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    try {
      const columns = database
        .prepare('PRAGMA table_info(ptc_execute_code_cell_coordinates)')
        .all()
        .map((row) => row['name']);
      assert.deepEqual(columns, [
        'cell_id',
        'state_root',
        'thread_id',
        'created_at_ms',
        'effective_timeout_ms',
        'orphan_reap_at_ms',
        'process_output_ref',
        'callback_output_ref',
        'identity_json',
        'container_id',
        'max_buffered_bytes_per_stream',
        'callback_tool_names_json',
        'store_callbacks_enabled',
        'stdout_read_offset_bytes',
        'stderr_read_offset_bytes',
      ]);
      assert.equal(columns.includes('token'), false);
      assert.equal(columns.includes('callback_socket_path'), false);
    } finally {
      database.close();
    }

    store.deletePtcExecuteCodeCellCoordinate(coordinate.cellId);
    assert.deepEqual(store.listPtcExecuteCodeCellCoordinates(), []);
    assert.deepEqual(
      store.readPtcExecuteCodeRunningWaitDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      delivery,
      'running wait delivery survives coordinate finalization until recovery consumes it',
    );
    assert.deepEqual(
      store.readPtcExecuteCodeRunningExecDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      execDelivery,
      'running exec delivery survives coordinate finalization until wait consumes it',
    );
    store.deletePtcExecuteCodeRunningWaitDelivery?.({
      threadId: coordinate.threadId,
      cellId: coordinate.cellId,
    });
    assert.equal(
      store.readPtcExecuteCodeRunningWaitDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      undefined,
    );
    store.deletePtcExecuteCodeRunningExecDelivery?.({
      threadId: coordinate.threadId,
      cellId: coordinate.cellId,
    });
    assert.equal(
      store.readPtcExecuteCodeRunningExecDelivery?.({
        threadId: coordinate.threadId,
        cellId: coordinate.cellId,
      }),
      undefined,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store preserves an unsupported database instead of replacing it', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  await mkdir(dirname(databasePath), { recursive: true });
  const futureDatabase = new DatabaseSync(databasePath);
  futureDatabase.exec('PRAGMA user_version = 18;');
  futureDatabase.close();
  const originalBytes = await readFile(databasePath);

  try {
    await assert.rejects(
      () => createDaemonRuntimeStateStore({ homeStateRoot }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'compatibility' &&
        /original database was preserved/u.test(error.message),
    );

    const preservedDatabase = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      const versionRow = preservedDatabase.prepare('PRAGMA user_version').get();
      assert.ok(versionRow, 'expected PRAGMA user_version to return one row');
      assert.equal(Object.hasOwn(versionRow, 'user_version'), true);
      assert.equal(versionRow['user_version'], 18);
    } finally {
      preservedDatabase.close();
    }
    assert.deepEqual(await readFile(databasePath), originalBytes);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store backs up and transactionally migrates an existing version-zero database once', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  await mkdir(dirname(databasePath), { recursive: true });
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE legacy_evidence (value TEXT NOT NULL) STRICT;
    INSERT INTO legacy_evidence (value) VALUES ('preserve-me');
  `);
  legacyDatabase.close();

  try {
    const firstStore = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-22T15:00:00.000Z'),
    });
    assert.deepEqual(firstStore.readDiagnostics().startupMigration, {
      backupCreated: true,
      fromVersion: 0,
      toVersion: 17,
    });
    firstStore.close();

    const backupDirectory = join(
      homeStateRoot,
      '.geulbat',
      'runtime-state-backups',
    );
    const backupEntries = await readdir(backupDirectory);
    assert.equal(backupEntries.length, 1);
    assert.match(
      backupEntries[0] ?? '',
      /^runtime-state-v0-to-v17-2026-07-22T15-00-00-000Z-[\da-f-]+\.sqlite3$/u,
    );

    const backupDatabase = new DatabaseSync(
      join(backupDirectory, backupEntries[0] ?? ''),
      { readOnly: true },
    );
    try {
      assert.equal(readIntegerPragma(backupDatabase, 'user_version'), 0);
      assert.equal(readLegacyEvidence(backupDatabase), 'preserve-me');
    } finally {
      backupDatabase.close();
    }

    const migratedDatabase = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      assert.equal(readIntegerPragma(migratedDatabase, 'user_version'), 17);
      assert.equal(readLegacyEvidence(migratedDatabase), 'preserve-me');
      // v12가 만든 run_usage_records는 v13이 되돌렸다 — 사용량은 제공자 보고를
      // 조회하는 방향으로 바뀌어 로컬 집계 테이블이 필요하지 않다.
      assert.equal(
        migratedDatabase
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_usage_records'",
          )
          .get(),
        undefined,
      );
      const migrations = migratedDatabase
        .prepare(
          'SELECT version, applied_at AS appliedAt FROM runtime_schema_migrations',
        )
        .all();
      assert.equal(migrations.length, 17);
      assert.equal(migrations[0]?.['version'], 1);
      assert.equal(migrations[0]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[1]?.['version'], 2);
      assert.equal(migrations[1]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[2]?.['version'], 3);
      assert.equal(migrations[2]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[3]?.['version'], 4);
      assert.equal(migrations[3]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[4]?.['version'], 5);
      assert.equal(migrations[5]?.['version'], 6);
      assert.equal(migrations[6]?.['version'], 7);
      assert.equal(migrations[7]?.['version'], 8);
      assert.equal(migrations[8]?.['version'], 9);
      assert.equal(migrations[9]?.['version'], 10);
      assert.equal(migrations[10]?.['version'], 11);
      assert.equal(migrations[11]?.['version'], 12);
      assert.equal(migrations[12]?.['version'], 13);
      assert.equal(migrations[13]?.['version'], 14);
      assert.equal(migrations[16]?.['version'], 17);
      assert.equal(migrations[4]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[5]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[6]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[7]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[8]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[9]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[10]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[11]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[12]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[13]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
      assert.equal(migrations[14]?.['appliedAt'], '2026-07-22T15:00:00.000Z');
    } finally {
      migratedDatabase.close();
    }

    const reopenedStore = await createDaemonRuntimeStateStore({
      homeStateRoot,
    });
    try {
      assert.equal(reopenedStore.readDiagnostics().startupMigration, null);
      assert.equal((await readdir(backupDirectory)).length, 1);
    } finally {
      reopenedStore.close();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store upgrades the landed version-one database before accepting launch requests', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  await mkdir(dirname(databasePath), { recursive: true });
  const versionOneDatabase = new DatabaseSync(databasePath);
  versionOneDatabase.exec(`
    CREATE TABLE runtime_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO runtime_schema_migrations (version, applied_at)
      VALUES (1, '2026-07-22T00:00:00.000Z');
    CREATE TABLE legacy_evidence (value TEXT NOT NULL) STRICT;
    INSERT INTO legacy_evidence (value) VALUES ('version-one-preserved');
    PRAGMA user_version = 1;
  `);
  versionOneDatabase.close();

  try {
    const store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T01:00:00.000Z'),
    });
    try {
      assert.deepEqual(store.readDiagnostics().startupMigration, {
        backupCreated: true,
        fromVersion: 1,
        toVersion: 17,
      });
      const accepted = store.enqueueSubagentLaunchBatch([
        makeLaunchRequest(9, 'call-after-v1-upgrade'),
      ]);
      assert.equal(accepted[0]?.launchState, 'queued');
    } finally {
      store.close();
    }

    const backupDirectory = join(
      homeStateRoot,
      '.geulbat',
      'runtime-state-backups',
    );
    const backupEntries = await readdir(backupDirectory);
    assert.equal(backupEntries.length, 1);
    assert.match(
      backupEntries[0] ?? '',
      /^runtime-state-v1-to-v17-2026-07-23T01-00-00-000Z-[\da-f-]+\.sqlite3$/u,
    );
    const backupDatabase = new DatabaseSync(
      join(backupDirectory, backupEntries[0] ?? ''),
      { readOnly: true },
    );
    try {
      assert.equal(readIntegerPragma(backupDatabase, 'user_version'), 1);
      assert.equal(readLegacyEvidence(backupDatabase), 'version-one-preserved');
      assert.throws(
        () =>
          backupDatabase
            .prepare('SELECT 1 FROM subagent_launch_requests')
            .get(),
        /no such table/u,
      );
    } finally {
      backupDatabase.close();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store migrates version-two launch rows without losing order or identity', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const childRunId = testRunId('version-two-child');
  const childThreadId = testThreadId(20);
  const parentRunId = testRunId('version-two-parent');
  const ownerThreadId = testThreadId(21);
  await mkdir(dirname(databasePath), { recursive: true });
  const versionTwoDatabase = new DatabaseSync(databasePath);
  versionTwoDatabase.exec(`
    CREATE TABLE runtime_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO runtime_schema_migrations (version, applied_at) VALUES
      (1, '2026-07-22T00:00:00.000Z'),
      (2, '2026-07-22T00:01:00.000Z');
    CREATE TABLE subagent_launch_requests (
      enqueue_order INTEGER PRIMARY KEY AUTOINCREMENT,
      child_run_id TEXT NOT NULL UNIQUE,
      child_thread_id TEXT NOT NULL UNIQUE,
      parent_run_id TEXT NOT NULL,
      owner_thread_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      batch_id TEXT,
      batch_position INTEGER NOT NULL CHECK (batch_position >= 0),
      launch_state TEXT NOT NULL CHECK (
        launch_state IN (
          'queued',
          'starting',
          'started',
          'cancelled',
          'failed_to_start'
        )
      ),
      priority_class TEXT NOT NULL CHECK (priority_class = 'normal'),
      input_json TEXT NOT NULL,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (parent_run_id, tool_call_id)
    ) STRICT;
    CREATE INDEX subagent_launch_requests_queue_order
      ON subagent_launch_requests (
        launch_state,
        priority_class,
        enqueue_order
      );
    PRAGMA user_version = 2;
  `);
  versionTwoDatabase
    .prepare(
      `
        INSERT INTO subagent_launch_requests (
          enqueue_order,
          child_run_id,
          child_thread_id,
          parent_run_id,
          owner_thread_id,
          tool_call_id,
          batch_id,
          batch_position,
          launch_state,
          priority_class,
          input_json,
          failure_reason,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 'queued', 'normal', '{}', NULL, ?, ?)
      `,
    )
    .run(
      7,
      childRunId,
      childThreadId,
      parentRunId,
      ownerThreadId,
      'call-version-two',
      '2026-07-22T00:02:00.000Z',
      '2026-07-22T00:02:00.000Z',
    );
  versionTwoDatabase.close();

  try {
    const store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T02:00:00.000Z'),
    });
    try {
      assert.deepEqual(store.readDiagnostics().startupMigration, {
        backupCreated: true,
        fromVersion: 2,
        toVersion: 17,
      });
      const migrated = store.readSubagentLaunchRequestByChildRunId(childRunId);
      assert.ok(migrated);
      assert.equal(migrated.enqueueOrder, 7);
      assert.equal(migrated.childThreadId, childThreadId);
      assert.equal(migrated.priorityClass, 'normal');

      const reprioritized = store.updateQueuedSubagentLaunchPriority({
        childRunId,
        ownerThreadId,
        priorityClass: 'high',
      });
      assert.equal(reprioritized.enqueueOrder, 7);
      assert.equal(reprioritized.priorityClass, 'high');

      const [next] = store.enqueueSubagentLaunchBatch([
        makeLaunchRequest(22, 'call-after-v2-upgrade'),
      ]);
      assert.ok(next);
      assert.equal(next.enqueueOrder, 8);
    } finally {
      store.close();
    }

    const backupEntries = await readdir(
      join(homeStateRoot, '.geulbat', 'runtime-state-backups'),
    );
    assert.equal(backupEntries.length, 1);
    assert.match(
      backupEntries[0] ?? '',
      /^runtime-state-v2-to-v17-2026-07-23T02-00-00-000Z-[\da-f-]+\.sqlite3$/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store atomically enqueues a same-round launch batch with stable identities', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  });
  const firstRequest = makeLaunchRequest(1, 'call-first');
  const secondRequest = makeLaunchRequest(1, 'call-second');

  try {
    const accepted = store.enqueueSubagentLaunchBatch([
      firstRequest,
      secondRequest,
    ]);
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0]?.launchState, 'queued');
    assert.equal(accepted[1]?.launchState, 'queued');
    assert.equal(accepted[0]?.batchId, accepted[1]?.batchId);
    assert.equal(typeof accepted[0]?.batchId, 'string');
    assert.deepEqual(
      accepted.map((request) => request.batchPosition),
      [0, 1],
    );
    assert.deepEqual(
      accepted.map((request) => request.enqueueOrder),
      [1, 2],
    );

    const firstAccepted = accepted[0];
    const secondAccepted = accepted[1];
    assert.ok(firstAccepted);
    assert.ok(secondAccepted);
    store.markSubagentLaunchStarting(firstAccepted.childRunId);
    store.markSubagentLaunchStarted(firstAccepted.childRunId);
    store.recordSubagentRuntimeObservation({
      childRunId: firstAccepted.childRunId,
      runtime: {
        phase: 'tool_running',
        observedAt: '2026-07-23T00:00:01.000Z',
        lastTool: {
          name: 'read_file',
          callId: 'call-read-runtime',
          state: 'running',
        },
        partialOutputAvailable: true,
        providerRequest: {
          startedAt: '2026-07-23T00:00:00.000Z',
          lastEventAt: '2026-07-23T00:00:00.750Z',
          endedAt: '2026-07-23T00:00:01.000Z',
          durationMs: 1_000,
          attemptCount: 2,
          retry: {
            available: false,
            performed: true,
            outcome: 'recovered',
          },
        },
      },
    });
    store.markSubagentLaunchFailedToStart({
      childRunId: secondAccepted.childRunId,
      reason: 'child transcript persistence failed',
    });
    const started = store.readSubagentLaunchRequest({
      parentRunId: firstRequest.parentRunId,
      toolCallId: firstRequest.toolCallId,
    });
    assert.equal(started?.launchState, 'started');
    assert.deepEqual(started?.runtime, {
      phase: 'tool_running',
      observedAt: '2026-07-23T00:00:01.000Z',
      lastTool: {
        name: 'read_file',
        callId: 'call-read-runtime',
        state: 'running',
      },
      partialOutputAvailable: true,
      providerRequest: {
        startedAt: '2026-07-23T00:00:00.000Z',
        lastEventAt: '2026-07-23T00:00:00.750Z',
        endedAt: '2026-07-23T00:00:01.000Z',
        durationMs: 1_000,
        attemptCount: 2,
        retry: {
          available: false,
          performed: true,
          outcome: 'recovered',
        },
      },
    });
    assert.deepEqual(
      store.readSubagentLaunchRequest({
        parentRunId: secondRequest.parentRunId,
        toolCallId: secondRequest.toolCallId,
      }),
      {
        ...secondAccepted,
        launchState: 'failed_to_start',
        failureReason: 'child transcript persistence failed',
      },
    );

    store.close();
    const reopened = await createDaemonRuntimeStateStore({ homeStateRoot });
    try {
      assert.deepEqual(
        reopened.readSubagentLaunchRequest({
          parentRunId: firstRequest.parentRunId,
          toolCallId: firstRequest.toolCallId,
        })?.childRunId,
        firstAccepted.childRunId,
      );
      const interrupted = reopened.readSubagentLaunchRequest({
        parentRunId: firstRequest.parentRunId,
        toolCallId: firstRequest.toolCallId,
      });
      assert.equal(interrupted?.launchState, 'interrupted');
      assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
      assert.deepEqual(interrupted?.runtime.providerRequest, {
        startedAt: '2026-07-23T00:00:00.000Z',
        lastEventAt: '2026-07-23T00:00:00.750Z',
        endedAt: '2026-07-23T00:00:01.000Z',
        durationMs: 1_000,
        attemptCount: 2,
        retry: {
          available: false,
          performed: true,
          outcome: 'recovered',
        },
      });
      assert.equal(
        reopened.readSubagentTerminalOutcomeByChildRunId(
          firstAccepted.childRunId,
        )?.result.terminalState,
        'failed',
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state restart reconciliation preserves only checkpoint-correlated active children', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-child-recovery-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [accepted] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(2, 'call-recoverable-started-child'),
  ]);
  assert.ok(accepted);
  store.markSubagentLaunchStarting(accepted.childRunId);
  store.markSubagentLaunchStarted(accepted.childRunId);
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      deferSubagentRestartReconciliation: true,
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(accepted.childRunId)
        ?.launchState,
      'started',
    );
    store.reconcileSubagentLaunchesAfterRestart?.({
      recoverableChildRunIds: [accepted.childRunId],
      recoverableParentRunIds: [],
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(accepted.childRunId)
        ?.launchState,
      'started',
    );
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(accepted.childRunId),
      undefined,
    );
    store.close();

    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      deferSubagentRestartReconciliation: true,
    });
    store.reconcileSubagentLaunchesAfterRestart?.({
      recoverableChildRunIds: [],
      recoverableParentRunIds: [],
    });
    const interrupted = store.readSubagentLaunchRequestByChildRunId(
      accepted.childRunId,
    );
    assert.equal(interrupted?.launchState, 'interrupted');
    assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(accepted.childRunId)?.result
        .reason,
      'daemon_restart',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store persists provider admission phases used by reconnect diagnostics', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [accepted] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(3, 'call-provider-admission'),
  ]);

  try {
    assert.ok(accepted);
    store.markSubagentLaunchStarting(accepted.childRunId);
    store.markSubagentLaunchStarted(accepted.childRunId);
    store.recordSubagentRuntimeObservation({
      childRunId: accepted.childRunId,
      runtime: {
        phase: 'rate_limit_waiting',
        observedAt: '2026-07-23T00:00:01.000Z',
        partialOutputAvailable: false,
      },
    });

    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(accepted.childRunId)?.runtime
        .phase,
      'rate_limit_waiting',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store applies queued controls atomically without changing same-class order', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let now = new Date('2026-07-23T03:00:00.000Z');
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => now,
  });
  const ownerThreadId = testThreadId(30);

  try {
    const [queued, starting] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(30, 'call-queued-control'),
      makeLaunchRequest(30, 'call-starting-control'),
    ]);
    assert.ok(queued);
    assert.ok(starting);
    assert.deepEqual(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId),
      queued,
    );

    now = new Date('2026-07-23T03:01:00.000Z');
    const reprioritized = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId,
      priorityClass: 'high',
    });
    assert.equal(reprioritized.priorityClass, 'high');
    assert.equal(reprioritized.enqueueOrder, queued.enqueueOrder);
    assert.equal(reprioritized.createdAt, queued.createdAt);
    assert.equal(reprioritized.updatedAt, now.toISOString());

    now = new Date('2026-07-23T03:02:00.000Z');
    const unchanged = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId,
      priorityClass: 'high',
    });
    assert.equal(unchanged.updatedAt, reprioritized.updatedAt);

    assert.throws(
      () =>
        store.updateQueuedSubagentLaunchPriority({
          childRunId: queued.childRunId,
          ownerThreadId: testThreadId(31),
          priorityClass: 'low',
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.priorityClass,
      'high',
    );

    const cancelled = store.cancelQueuedSubagentLaunchRequest({
      childRunId: queued.childRunId,
      ownerThreadId,
    });
    assert.equal(cancelled.launchState, 'cancelled');
    assert.equal(cancelled.enqueueOrder, queued.enqueueOrder);
    assert.throws(
      () => store.markSubagentLaunchStarting(queued.childRunId),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );

    store.markSubagentLaunchStarting(starting.childRunId);
    const nonQueuedPriority = store.updateQueuedSubagentLaunchPriority({
      childRunId: starting.childRunId,
      ownerThreadId,
      priorityClass: 'low',
    });
    assert.equal(nonQueuedPriority.launchState, 'starting');
    assert.equal(nonQueuedPriority.priorityClass, 'normal');
    const nonQueuedCancel = store.cancelQueuedSubagentLaunchRequest({
      childRunId: starting.childRunId,
      ownerThreadId,
    });
    assert.equal(nonQueuedCancel.launchState, 'starting');
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store persists defer reasons and reads promotion order from durable priority', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const ownerThreadId = testThreadId(32);

  try {
    const [low, high] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(32, 'call-defer-low'),
      makeLaunchRequest(32, 'call-defer-high'),
    ]);
    assert.ok(low);
    assert.ok(high);
    assert.deepEqual(store.readSubagentLaunchInput(low.childRunId), {
      ...makeLaunchRequest(32, 'call-defer-low'),
      ultraReasoning: false,
    });
    store.updateQueuedSubagentLaunchPriority({
      childRunId: low.childRunId,
      ownerThreadId,
      priorityClass: 'low',
    });
    store.updateQueuedSubagentLaunchPriority({
      childRunId: high.childRunId,
      ownerThreadId,
      priorityClass: 'high',
    });

    const deferred = store.markSubagentLaunchDeferredBatch({
      childRunIds: [low.childRunId, high.childRunId],
      deferReason: 'batch_group_wait',
    });
    assert.deepEqual(
      deferred.map((request) => request.deferReason),
      ['batch_group_wait', 'batch_group_wait'],
    );
    assert.deepEqual(
      store
        .readQueuedSubagentLaunchRequests()
        .map((request) => request.childRunId),
      [high.childRunId, low.childRunId],
    );

    store.markSubagentLaunchStarting(high.childRunId);
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(high.childRunId)?.deferReason,
      null,
    );
    const cancelled = store.cancelQueuedSubagentLaunchRequest({
      childRunId: low.childRunId,
      ownerThreadId,
    });
    assert.equal(cancelled.deferReason, null);

    const [starting, stillQueued] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(32, 'call-defer-starting'),
      makeLaunchRequest(32, 'call-defer-still-queued'),
    ]);
    assert.ok(starting);
    assert.ok(stillQueued);
    store.markSubagentLaunchStarting(starting.childRunId);
    assert.throws(
      () =>
        store.markSubagentLaunchDeferredBatch({
          childRunIds: [starting.childRunId, stillQueued.childRunId],
          deferReason: 'configured_capacity',
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(stillQueued.childRunId)
        ?.deferReason,
      null,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store rolls back the whole batch when one launch identity conflicts', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const existing = makeLaunchRequest(2, 'call-existing');
  const uncommitted = makeLaunchRequest(2, 'call-must-roll-back');

  try {
    store.enqueueSubagentLaunchBatch([existing]);
    assert.throws(
      () => store.enqueueSubagentLaunchBatch([uncommitted, existing]),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.equal(
      store.readSubagentLaunchRequest({
        parentRunId: uncommitted.parentRunId,
        toolCallId: uncommitted.toolCallId,
      }),
      undefined,
    );
    assert.equal(
      store.readSubagentLaunchRequest({
        parentRunId: existing.parentRunId,
        toolCallId: existing.toolCallId,
      })?.launchState,
      'queued',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store replays terminal delivery after reopen and keeps exact outcome after acknowledgement', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(40);
  const result = makeTerminalResult(40, 'delivery-terminal-replay');
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T04:00:00.000Z'),
  });

  try {
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    });
    assert.equal(recorded.inserted, true);
    assert.equal(
      recorded.outcome.resultRef,
      `subagent-result:${result.deliveryId}`,
    );
    assert.equal(recorded.outcome.resultDigest, sha256Digest(result.result));
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByResultRef(recorded.outcome.resultRef),
      recorded.outcome,
    );
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [recorded.outcome],
    );

    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [recorded.outcome],
    );

    store.acknowledgeSubagentTerminalDeliveries({
      ownerThreadId,
      deliveryIds: [result.deliveryId],
    });
    const acknowledgedOutcome = {
      ...recorded.outcome,
      resultDeliveryState: 'acknowledged' as const,
    };
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [],
    );
    assert.deepEqual(store.readSubagentTerminalDeliveries(ownerThreadId), [
      acknowledgedOutcome,
    ]);
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      acknowledgedOutcome,
    );

    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    assert.deepEqual(store.readSubagentTerminalDeliveries(ownerThreadId), [
      acknowledgedOutcome,
    ]);
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      acknowledgedOutcome,
    );
    store.clearSubagentTerminalDeliveries(ownerThreadId);
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      undefined,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store preserves graceful daemon shutdown as a durable terminal reason', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(42);
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const result = {
    ...makeTerminalResult(42, 'delivery-daemon-shutdown'),
    terminalState: 'cancelled',
    reason: 'daemon_shutdown',
  } as const;

  try {
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    });

    assert.equal(recorded.outcome.result.reason, 'daemon_shutdown');
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      recorded.outcome,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store migrates existing version-nine terminal history without loss', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const ownerThreadId = testThreadId(43);
  const result = {
    ...makeTerminalResult(43, 'delivery-before-terminal-reason-upgrade'),
    terminalState: 'failed',
    reason: 'daemon_restart',
  } as const;
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    }).outcome;
    store.close();

    const versionNineDatabase = new DatabaseSync(databasePath);
    versionNineDatabase.exec(`
      ALTER TABLE subagent_launch_requests
        DROP COLUMN provider_request_json;
      DROP TABLE ptc_execute_code_running_exec_deliveries;
      DROP TABLE ptc_execute_code_running_wait_deliveries;
      DROP INDEX ptc_execute_code_cell_coordinates_owner;
      DROP TABLE ptc_execute_code_cell_coordinates;
      DROP TABLE mcp_session_coordinates;
      DELETE FROM runtime_schema_migrations
      WHERE version IN (10, 11, 12, 13, 14, 15, 16, 17);
      PRAGMA user_version = 9;
    `);
    versionNineDatabase.close();

    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    assert.deepEqual(store.readDiagnostics().startupMigration, {
      backupCreated: true,
      fromVersion: 9,
      toVersion: 17,
    });
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      recorded,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store makes terminal recording idempotent but rejects divergent identity reuse', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(41);
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const result = makeTerminalResult(41, 'delivery-terminal-idempotent');

  try {
    const first = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    });
    const duplicate = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result: { ...result },
    });
    assert.equal(first.inserted, true);
    assert.deepEqual(duplicate, { inserted: false, outcome: first.outcome });

    assert.throws(
      () =>
        store.recordSubagentTerminalDelivery({
          ownerThreadId,
          result: { ...result, result: 'different terminal body' },
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.throws(
      () =>
        store.recordSubagentTerminalDelivery({
          ownerThreadId,
          result: {
            ...result,
            childRunId: testRunId('different-child'),
          },
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [first.outcome],
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state restart reconciliation preserves queued children only for recoverable parents', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-queued-parent-recovery-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [recoverable, orphaned] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(3, 'call-recoverable-queued-child'),
    makeLaunchRequest(4, 'call-orphaned-queued-child'),
  ]);
  assert.ok(recoverable);
  assert.ok(orphaned);
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      deferSubagentRestartReconciliation: true,
    });
    store.reconcileSubagentLaunchesAfterRestart?.({
      recoverableChildRunIds: [],
      recoverableParentRunIds: [recoverable.parentRunId],
    });

    const preserved = store.readSubagentLaunchRequestByChildRunId(
      recoverable.childRunId,
    );
    assert.equal(preserved?.launchState, 'queued');
    assert.equal(preserved?.deferReason, 'recovery_reconciliation');
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(recoverable.childRunId),
      undefined,
    );

    const interrupted = store.readSubagentLaunchRequestByChildRunId(
      orphaned.childRunId,
    );
    assert.equal(interrupted?.launchState, 'interrupted');
    assert.equal(interrupted?.deferReason, null);
    assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
    const outcome = store.readSubagentTerminalOutcomeByChildRunId(
      orphaned.childRunId,
    );
    assert.ok(outcome);
    assert.equal(outcome.result.reason, 'daemon_restart');
    assert.match(outcome.result.result, /parent run could not be recovered/u);
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store preserves queued work and atomically interrupts false-running child launches after restart', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(50);
  const queuedInput = makeLaunchRequest(50, 'call-recovery-queued');
  const startingInput = makeLaunchRequest(50, 'call-recovery-starting');
  const startedInput = makeLaunchRequest(50, 'call-recovery-started');
  const terminalInput = makeLaunchRequest(50, 'call-recovery-terminal');
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T05:00:00.000Z'),
  });

  try {
    const [queued, starting, started, alreadyTerminal] =
      store.enqueueSubagentLaunchBatch([
        queuedInput,
        startingInput,
        startedInput,
        terminalInput,
      ]);
    assert.ok(queued);
    assert.ok(starting);
    assert.ok(started);
    assert.ok(alreadyTerminal);
    store.markSubagentLaunchStarting(starting.childRunId);
    store.markSubagentLaunchStarting(started.childRunId);
    store.markSubagentLaunchStarted(started.childRunId);
    store.markSubagentLaunchStarting(alreadyTerminal.childRunId);
    store.markSubagentLaunchStarted(alreadyTerminal.childRunId);

    const priorTerminalResult = {
      ...makeTerminalResult(50, 'delivery-before-restart'),
      parentRunId: alreadyTerminal.parentRunId,
      childRunId: alreadyTerminal.childRunId,
      childThreadId: alreadyTerminal.childThreadId,
    };
    const priorTerminal = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result: priorTerminalResult,
    }).outcome;

    store.close();
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T05:05:00.000Z'),
    });

    assert.deepEqual(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId),
      {
        ...queued,
        deferReason: 'recovery_reconciliation',
        updatedAt: '2026-07-23T05:05:00.000Z',
      },
    );
    for (const active of [starting, started]) {
      const interrupted = store.readSubagentLaunchRequestByChildRunId(
        active.childRunId,
      );
      assert.equal(interrupted?.launchState as string, 'interrupted');
      assert.equal(interrupted?.deferReason, null);
      assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
      assert.equal(interrupted?.updatedAt, '2026-07-23T05:05:00.000Z');

      const outcome = store.readSubagentTerminalOutcomeByChildRunId(
        active.childRunId,
      );
      assert.ok(outcome);
      assert.equal(outcome.ownerThreadId, ownerThreadId);
      assert.equal(outcome.result.parentRunId, active.parentRunId);
      assert.equal(outcome.result.childThreadId, active.childThreadId);
      assert.equal(outcome.result.subagentType, 'explorer');
      assert.equal(outcome.result.terminalState, 'failed');
      assert.equal(outcome.result.reason, 'daemon_restart');
      assert.equal(
        outcome.result.result,
        'sub-agent interrupted because the daemon restarted before a durable terminal outcome was recorded',
      );
      assert.equal(outcome.result.completedAt, '2026-07-23T05:05:00.000Z');
    }
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(alreadyTerminal.childRunId),
      priorTerminal,
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(alreadyTerminal.childRunId)
        ?.launchState,
      'started',
    );

    const firstPending =
      store.readPendingSubagentTerminalDeliveries(ownerThreadId);
    assert.equal(firstPending.length, 3);
    const firstPendingByChild = new Map(
      firstPending.map((outcome) => [outcome.result.childRunId, outcome]),
    );
    assert.deepEqual(
      firstPendingByChild.get(alreadyTerminal.childRunId),
      priorTerminal,
    );

    store.close();
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T05:10:00.000Z'),
    });
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      firstPending,
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)?.updatedAt,
      '2026-07-23T05:05:00.000Z',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state retry creates one fresh child identity and preserves the interrupted attempt', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(70);
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T07:00:00.000Z'),
  });

  try {
    const originalInput = makeLaunchRequest(70, 'call-original-attempt');
    const [original] = store.enqueueSubagentLaunchBatch([originalInput]);
    assert.ok(original);
    store.markSubagentLaunchStarting(original.childRunId);
    store.markSubagentLaunchStarted(original.childRunId);
    store.close();

    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T07:01:00.000Z'),
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(original.childRunId)
        ?.launchState,
      'interrupted',
    );
    const priorOutcome = store.readSubagentTerminalOutcomeByChildRunId(
      original.childRunId,
    );
    assert.ok(priorOutcome);

    const retryArgs = {
      previousChildRunId: original.childRunId,
      ownerThreadId,
      parentRunId: testRunId('retry-parent-70'),
      toolCallId: 'call-retry-attempt',
      stateRoot: '/tmp/retry-home-state',
      workingDirectory: '/tmp/retry-workspace',
      permissionMode: 'basic' as const,
    };
    const created = store.retryInterruptedSubagentLaunch(retryArgs);

    assert.equal(created.disposition, 'created');
    assert.notEqual(created.request.childRunId, original.childRunId);
    assert.notEqual(created.request.childThreadId, original.childThreadId);
    assert.equal(created.request.previousChildRunId, original.childRunId);
    assert.equal(created.request.launchState, 'queued');
    assert.deepEqual(created.request.runtime, {
      phase: 'queued',
      observedAt: '2026-07-23T07:01:00.000Z',
      partialOutputAvailable: false,
      previousChildRunId: original.childRunId,
    });
    assert.equal(created.input.task, originalInput.task);
    assert.equal(created.input.parentRunId, retryArgs.parentRunId);
    assert.equal(created.input.ownerThreadId, ownerThreadId);
    assert.equal(created.input.toolCallId, retryArgs.toolCallId);
    assert.equal(created.input.stateRoot, retryArgs.stateRoot);
    assert.equal(created.input.workingDirectory, retryArgs.workingDirectory);
    assert.equal(created.input.permissionMode, 'basic');
    assert.deepEqual(created.input.modelPin, originalInput.modelPin);
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(original.childRunId),
      priorOutcome,
    );

    const sameCall = store.retryInterruptedSubagentLaunch(retryArgs);
    assert.equal(sameCall.disposition, 'same_call_replay');
    assert.equal(sameCall.request.childRunId, created.request.childRunId);

    const duplicate = store.retryInterruptedSubagentLaunch({
      ...retryArgs,
      toolCallId: 'call-competing-retry',
    });
    assert.equal(duplicate.disposition, 'already_retried');
    assert.equal(duplicate.request.childRunId, created.request.childRunId);
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(original.childRunId)
        ?.launchState,
      'interrupted',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state survives process death before commit and reconciles a committed active attempt after death', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-crash-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const rollbackInput = makeLaunchRequest(90, 'call-crash-before-commit');
  const activeInput = makeLaunchRequest(90, 'call-crash-after-commit');
  let transactionChild: ChildProcess | undefined;
  let activeChild: ChildProcess | undefined;

  try {
    const initialStore = await createDaemonRuntimeStateStore({
      homeStateRoot,
    });
    const [rollbackProbe] = initialStore.enqueueSubagentLaunchBatch([
      rollbackInput,
    ]);
    assert.ok(rollbackProbe);
    initialStore.close();

    transactionChild = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { DatabaseSync } from 'node:sqlite';
          const database = new DatabaseSync(process.env.RUNTIME_DATABASE_PATH);
          database.exec('BEGIN IMMEDIATE;');
          database
            .prepare("UPDATE subagent_launch_requests SET priority_class = 'high' WHERE child_run_id = ?")
            .run(process.env.CHILD_RUN_ID);
          process.send?.('ready');
          await new Promise(() => {});
        `,
      ],
      {
        env: {
          ...process.env,
          CHILD_RUN_ID: rollbackProbe.childRunId,
          RUNTIME_DATABASE_PATH: databasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    await waitForCrashFixtureReady(transactionChild);
    const transactionExit = once(transactionChild, 'exit');
    assert.equal(transactionChild.kill('SIGKILL'), true);
    await transactionExit;

    const afterUncommittedDeath = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      const row = afterUncommittedDeath
        .prepare(
          'SELECT priority_class AS priorityClass FROM subagent_launch_requests WHERE child_run_id = ?',
        )
        .get(rollbackProbe.childRunId);
      assert.ok(row);
      assert.equal(row['priorityClass'], 'normal');
    } finally {
      afterUncommittedDeath.close();
    }

    activeChild = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          const { createDaemonRuntimeStateStore } =
            await import(process.env.RUNTIME_STORE_MODULE_URL);
          const store = await createDaemonRuntimeStateStore({
            homeStateRoot: process.env.HOME_STATE_ROOT,
          });
          const [launch] = store.enqueueSubagentLaunchBatch([
            JSON.parse(process.env.ACTIVE_INPUT_JSON),
          ]);
          store.markSubagentLaunchStarting(launch.childRunId);
          store.markSubagentLaunchStarted(launch.childRunId);
          process.send?.('ready');
          await new Promise(() => {});
        `,
      ],
      {
        env: {
          ...process.env,
          ACTIVE_INPUT_JSON: JSON.stringify(activeInput),
          HOME_STATE_ROOT: homeStateRoot,
          RUNTIME_STORE_MODULE_URL: new URL(
            './runtime-state-store.js',
            import.meta.url,
          ).href,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    await waitForCrashFixtureReady(activeChild);
    const activeExit = once(activeChild, 'exit');
    assert.equal(activeChild.kill('SIGKILL'), true);
    await activeExit;

    const recovered = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T07:30:00.000Z'),
    });
    try {
      const active = recovered.readSubagentLaunchRequest({
        parentRunId: activeInput.parentRunId,
        toolCallId: activeInput.toolCallId,
      });
      assert.ok(active);
      assert.equal(active.launchState, 'interrupted');
      assert.equal(active.failureReason, 'daemon_restart_interrupted');
      assert.ok(
        recovered.readSubagentTerminalOutcomeByChildRunId(active.childRunId),
      );
      assert.equal(
        recovered.readSubagentLaunchRequestByChildRunId(
          rollbackProbe.childRunId,
        )?.priorityClass,
        'normal',
      );
    } finally {
      recovered.close();
    }
  } finally {
    transactionChild?.kill('SIGKILL');
    activeChild?.kill('SIGKILL');
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state restart reconciliation rolls back every recovery mutation when one active launch input is invalid', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T06:00:00.000Z'),
  });
  const queuedInput = makeLaunchRequest(60, 'call-rollback-queued');
  const validActiveInput = makeLaunchRequest(60, 'call-rollback-valid-active');
  const invalidActiveInput = makeLaunchRequest(
    60,
    'call-rollback-invalid-active',
  );

  try {
    const [queued, validActive, invalidActive] =
      store.enqueueSubagentLaunchBatch([
        queuedInput,
        validActiveInput,
        invalidActiveInput,
      ]);
    assert.ok(queued);
    assert.ok(validActive);
    assert.ok(invalidActive);
    store.markSubagentLaunchStarting(validActive.childRunId);
    store.markSubagentLaunchStarted(validActive.childRunId);
    store.markSubagentLaunchStarting(invalidActive.childRunId);
    store.markSubagentLaunchStarted(invalidActive.childRunId);
    store.close();

    const tampered = new DatabaseSync(databasePath);
    try {
      tampered
        .prepare(
          `
            UPDATE subagent_launch_requests
            SET input_json = '{}'
            WHERE child_run_id = ?
          `,
        )
        .run(invalidActive.childRunId);
    } finally {
      tampered.close();
    }

    await assert.rejects(
      () =>
        createDaemonRuntimeStateStore({
          homeStateRoot,
          now: () => new Date('2026-07-23T06:05:00.000Z'),
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'recovery',
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = preserved
        .prepare(
          `
            SELECT
              child_run_id AS childRunId,
              launch_state AS launchState,
              defer_reason AS deferReason,
              failure_reason AS failureReason,
              updated_at AS updatedAt
            FROM subagent_launch_requests
            ORDER BY enqueue_order
        `,
        )
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        {
          childRunId: queued.childRunId,
          launchState: 'queued',
          deferReason: null,
          failureReason: null,
          updatedAt: '2026-07-23T06:00:00.000Z',
        },
        {
          childRunId: validActive.childRunId,
          launchState: 'started',
          deferReason: null,
          failureReason: null,
          updatedAt: '2026-07-23T06:00:00.000Z',
        },
        {
          childRunId: invalidActive.childRunId,
          launchState: 'started',
          deferReason: null,
          failureReason: null,
          updatedAt: '2026-07-23T06:00:00.000Z',
        },
      ]);
      const terminalCount = preserved
        .prepare('SELECT COUNT(*) AS count FROM subagent_terminal_outcomes')
        .get();
      assert.ok(terminalCount);
      assert.deepEqual({ ...terminalCount }, { count: 0 });
    } finally {
      preserved.close();
    }
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function waitForCrashFixtureReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(
        new Error(
          `runtime-state crash fixture did not become ready: ${stderr.trim()}`,
        ),
      );
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      rejectReady(
        new Error(
          `runtime-state crash fixture exited before ready: code=${code} signal=${signal} stderr=${stderr.trim()}`,
        ),
      );
    };
    const onMessage = (message: unknown): void => {
      if (message !== 'ready') {
        return;
      }
      cleanup();
      resolveReady();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

void test('runtime-state store reports corruption without replacing the original bytes', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const originalBytes = Buffer.from('not-a-sqlite-database\0preserve');
  await mkdir(dirname(databasePath), { recursive: true });
  await writeFile(databasePath, originalBytes);

  try {
    await assert.rejects(
      () => createDaemonRuntimeStateStore({ homeStateRoot }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'health_check' &&
        /original database was preserved/u.test(error.message),
    );
    assert.deepEqual(await readFile(databasePath), originalBytes);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function readIntegerPragma(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  assert.ok(row, `expected PRAGMA ${pragma} to return one row`);
  const value = row[pragma];
  assert.equal(typeof value, 'number');
  return Number(value);
}

function readLegacyEvidence(database: DatabaseSync): string {
  const row = database.prepare('SELECT value FROM legacy_evidence').get();
  assert.ok(row, 'expected preserved legacy evidence');
  assert.equal(typeof row['value'], 'string');
  return String(row['value']);
}

function makeLaunchRequest(
  threadSeed: number,
  toolCallId: string,
): SubagentLaunchRequestInput {
  return {
    toolCallId,
    task: `inspect ${toolCallId}`,
    subagentType: 'explorer',
    capabilities: [],
    parentRunId: testRunId(`parent-${threadSeed}`),
    ownerThreadId: testThreadId(threadSeed),
    stateRoot: '/tmp/geulbat-state',
    workingDirectory: '/tmp/geulbat-workspace',
    modelPin: TEST_INHERITED_SOL_MODEL_PIN,
    subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  };
}

function makeTerminalResult(
  threadSeed: number,
  deliveryId: string,
): BackgroundChildResult {
  return {
    deliveryId,
    parentRunId: testRunId(`terminal-parent-${threadSeed}`),
    childRunId: testRunId(`terminal-child-${threadSeed}`),
    childThreadId: testThreadId(threadSeed + 1),
    subagentType: 'worker',
    capabilities: ['ptc'],
    toolSurface: 'worker',
    terminalState: 'completed',
    result: `terminal result ${threadSeed}`,
    completedAt: '2026-07-23T04:00:00.000Z',
    elapsedMs: 25,
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
    },
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  };
}

function expectStoreErrorCause(pattern: RegExp) {
  return (error: unknown): true => {
    assert.ok(
      error instanceof DaemonRuntimeStateStoreError,
      'retry failures surface as a typed runtime-state store error',
    );
    const cause = error.cause;
    assert.ok(
      cause instanceof Error,
      'the original guard error is preserved as the cause',
    );
    assert.match(cause.message, pattern);
    return true;
  };
}

void test('runtime-state store refuses to retry a phantom, cross-thread, or non-interrupted launch', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-retry-guard-'),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const homeStateRoot = join(fixtureRoot, 'home-state');

  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const startedRequest = makeLaunchRequest(40, 'call-retry-guard-started');
  const queuedRequest = makeLaunchRequest(40, 'call-retry-guard-queued');
  const [started, queued] = store.enqueueSubagentLaunchBatch([
    startedRequest,
    queuedRequest,
  ]);
  assert.ok(started);
  assert.ok(queued);
  store.markSubagentLaunchStarting(started.childRunId);
  store.markSubagentLaunchStarted(started.childRunId);
  store.close();

  // Reopening promotes the false-running child to `interrupted`; the queued one
  // is left untouched, so it remains a non-retryable launch state.
  store = await createDaemonRuntimeStateStore({ homeStateRoot });
  try {
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(started.childRunId)
        ?.launchState,
      'interrupted',
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.launchState,
      'queued',
    );

    const guardArgs = (previousChildRunId: RunId, ownerThreadId: ThreadId) => ({
      previousChildRunId,
      ownerThreadId,
      parentRunId: testRunId('parent-40'),
      toolCallId: 'call-retry-guard-new',
      stateRoot: '/tmp/geulbat-retry-state',
      workingDirectory: '/tmp/geulbat-retry-workspace',
    });

    // A retry that names a child the store never persisted must fail closed.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          guardArgs(testRunId('phantom-child'), testThreadId(40)),
        ),
      expectStoreErrorCause(/does not exist/u),
    );

    // A retry requested by a different owner thread must not cross the boundary.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          guardArgs(started.childRunId, testThreadId(999)),
        ),
      expectStoreErrorCause(/belongs to another owner thread/u),
    );

    // A launch that is still queued (live) cannot be retried.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          guardArgs(queued.childRunId, testThreadId(40)),
        ),
      expectStoreErrorCause(/cannot be retried from queued/u),
    );
  } finally {
    store.close();
  }
});

void test('runtime-state store retry replays the same call, dedupes across calls, and rejects tool-call hijack', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-retry-dispose-'),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const homeStateRoot = join(fixtureRoot, 'home-state');

  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [childA, childB] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(41, 'call-A'),
    makeLaunchRequest(41, 'call-B'),
  ]);
  assert.ok(childA);
  assert.ok(childB);
  for (const child of [childA, childB]) {
    store.markSubagentLaunchStarting(child.childRunId);
    store.markSubagentLaunchStarted(child.childRunId);
  }
  store.close();

  store = await createDaemonRuntimeStateStore({ homeStateRoot });
  try {
    const retryArgs = (previousChildRunId: RunId, toolCallId: string) => ({
      previousChildRunId,
      ownerThreadId: testThreadId(41),
      parentRunId: testRunId('parent-41'),
      toolCallId,
      stateRoot: '/tmp/geulbat-retry-state',
      workingDirectory: '/tmp/geulbat-retry-workspace',
    });

    const created = store.retryInterruptedSubagentLaunch(
      retryArgs(childA.childRunId, 'call-retry-A'),
    );
    assert.equal(created.disposition, 'created');
    assert.notEqual(created.request.childRunId, childA.childRunId);
    assert.equal(created.request.previousChildRunId, childA.childRunId);

    // Re-issuing the identical tool call replays the same durable retry request.
    const replay = store.retryInterruptedSubagentLaunch(
      retryArgs(childA.childRunId, 'call-retry-A'),
    );
    assert.equal(replay.disposition, 'same_call_replay');
    assert.equal(replay.request.childRunId, created.request.childRunId);

    // A fresh tool call for the same interrupted child returns the existing retry.
    const deduped = store.retryInterruptedSubagentLaunch(
      retryArgs(childA.childRunId, 'call-retry-A-again'),
    );
    assert.equal(deduped.disposition, 'already_retried');
    assert.equal(deduped.request.childRunId, created.request.childRunId);

    // A different interrupted child cannot claim a tool-call slot already owned
    // by another retry lineage.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          retryArgs(childB.childRunId, 'call-retry-A'),
        ),
      expectStoreErrorCause(/conflicts with child run/u),
    );
  } finally {
    store.close();
  }
});

void test('runtime-state store launch controls enforce ownership, valid priority, and queued-only mutation', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-controls-'),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: join(fixtureRoot, 'home-state'),
  });
  try {
    const [queued] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(42, 'call-control'),
    ]);
    assert.ok(queued);

    // Controls on a child the store never persisted must fail closed.
    assert.throws(
      () =>
        store.updateQueuedSubagentLaunchPriority({
          childRunId: testRunId('control-ghost'),
          ownerThreadId: testThreadId(42),
          priorityClass: 'high',
        }),
      expectStoreErrorCause(/does not exist/u),
    );

    // A control issued by a different owner thread must not cross the boundary.
    assert.throws(
      () =>
        store.cancelQueuedSubagentLaunchRequest({
          childRunId: queued.childRunId,
          ownerThreadId: testThreadId(777),
        }),
      expectStoreErrorCause(/does not belong to owner thread/u),
    );

    // An unrecognized priority class is rejected before any row is touched.
    assert.throws(
      () =>
        store.updateQueuedSubagentLaunchPriority({
          childRunId: queued.childRunId,
          ownerThreadId: testThreadId(42),
          priorityClass: 'urgent' as SubagentLaunchPriorityClass,
        }),
      expectStoreErrorCause(/invalid subagent launch priority/u),
    );

    // A valid priority change is applied while the launch is still queued.
    const raised = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
      priorityClass: 'high',
    });
    assert.equal(raised.launchState, 'queued');
    assert.equal(raised.priorityClass, 'high');

    // Re-applying the same priority is an idempotent no-op.
    const unchanged = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
      priorityClass: 'high',
    });
    assert.equal(unchanged.priorityClass, 'high');

    store.markSubagentLaunchStarting(queued.childRunId);
    store.markSubagentLaunchStarted(queued.childRunId);

    // Once a launch leaves the queue, priority and cancel controls are inert
    // no-ops that report the current durable state without mutating it.
    const afterStart = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
      priorityClass: 'low',
    });
    assert.equal(afterStart.launchState, 'started');
    assert.equal(afterStart.priorityClass, 'high');

    const cancelInert = store.cancelQueuedSubagentLaunchRequest({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
    });
    assert.equal(cancelInert.launchState, 'started');

    // Re-driving a started launch back through the starting transition is a
    // rejected state change, not a silent overwrite.
    assert.throws(
      () => store.markSubagentLaunchStarting(queued.childRunId),
      expectStoreErrorCause(/cannot transition from started to starting/u),
    );
  } finally {
    store.close();
  }
});

void test('runtime-state persists the isolated Qwen subagent model pin', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-state-qwen-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    const input: SubagentLaunchRequestInput = {
      ...makeLaunchRequest(96, 'call-qwen-model-pin'),
      modelPin: {
        modelId: 'qwen3.8-max-preview',
        providerRunSelection: {
          providerModel: {
            providerId: 'qwen_token_plan',
            model: 'qwen3.8-max-preview',
          },
          reasoningEffort: 'high',
        },
        selectionSource: 'user_fixed',
      },
    };
    const [queued] = store.enqueueSubagentLaunchBatch([input]);
    assert.ok(queued);
    store.markSubagentLaunchStarting(queued.childRunId);
    store.markSubagentLaunchStarted(queued.childRunId);
    store.close();

    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    const retried = store.retryInterruptedSubagentLaunch({
      previousChildRunId: queued.childRunId,
      ownerThreadId: input.ownerThreadId,
      parentRunId: testRunId('qwen-retry-parent-96'),
      toolCallId: 'call-qwen-model-pin-retry',
      stateRoot: input.stateRoot,
      workingDirectory: input.workingDirectory,
      permissionMode: 'basic',
    });
    assert.equal(retried.disposition, 'created');
    assert.deepEqual(retried.input.modelPin, input.modelPin);
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
