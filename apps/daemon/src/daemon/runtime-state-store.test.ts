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
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DaemonRuntimeStateStoreError,
  createDaemonRuntimeStateStore,
  resolveDaemonRuntimeStateDatabasePath,
} from './runtime-state-store.js';
import { makeLaunchRequest } from '../test-support/runtime-state-store.js';
import { testRunId } from '../test-support/run-id.js';
import { testThreadId } from '../test-support/thread-id.js';

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
