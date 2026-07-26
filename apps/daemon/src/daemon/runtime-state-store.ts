import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertRunId,
  assertThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';

import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';
import { isRecord } from './runtime-json.js';
import {
  resolveSubagentToolSurfaceProfile,
  type BackgroundChildResult,
  type SubagentLaunchRequestInput,
  type SubagentLaunchRequestStore,
  type SubagentTerminalDeliveryStore,
} from './subagent-runtime-contracts.js';
import {
  closeDatabase,
  createPreMigrationBackup,
  readNumberPragma,
  readSchemaVersion,
  readStringPragma,
  runHealthCheck,
  runImmediateTransaction,
  runRuntimeStateMigrations,
  RUNTIME_STATE_SCHEMA_VERSION,
  validateMigrationHistory,
} from './runtime-state-database.js';
import {
  deleteMcpSessionCoordinate,
  persistMcpSessionCoordinate,
  readMcpSessionCoordinate,
} from './runtime-state-mcp-session-store.js';
import type { McpSessionCoordinateStore } from './mcp/global-mcp-contract.js';
import { hasErrorCode } from './utils/error.js';
import {
  cancelQueuedSubagentLaunchRequest,
  enqueueSubagentLaunchBatch,
  markSubagentLaunchDeferredBatch,
  parsePersistedSubagentLaunchInput,
  readQueuedSubagentLaunchRequests,
  readSubagentLaunchRequest,
  readSubagentLaunchRequestByChildRunId,
  recordSubagentRuntimeObservation,
  retryInterruptedSubagentLaunch,
  transitionSubagentLaunchRequest,
  updateQueuedSubagentLaunchPriority,
} from './runtime-state-subagent-launch-store.js';
import {
  acknowledgeSubagentTerminalDeliveries,
  clearSubagentTerminalDeliveries,
  isSubagentResultReaderInOwnerScope,
  parseBackgroundChildResult,
  readPendingSubagentTerminalDeliveries,
  readSubagentTerminalDeliveries,
  readSubagentTerminalOutcomeByChildRunId,
  readSubagentTerminalOutcomeByResultRef,
  recordSubagentTerminalDelivery,
  recordSubagentTerminalDeliveryInTransaction,
} from './runtime-state-subagent-terminal-delivery-store.js';

const RUNTIME_STATE_DATABASE_FILE = 'runtime-state.sqlite3';
const SQLITE_SYNCHRONOUS_FULL = 2;
const DAEMON_RESTART_INTERRUPTION_REASON = 'daemon_restart_interrupted';
const DAEMON_RESTART_INTERRUPTION_RESULT =
  'sub-agent interrupted because the daemon restarted before a durable terminal outcome was recorded';

type DaemonRuntimeStateStoreErrorStage =
  | 'backup'
  | 'compatibility'
  | 'configuration'
  | 'health_check'
  | 'migration'
  | 'open'
  | 'operation'
  | 'recovery';

export class DaemonRuntimeStateStoreError extends Error {
  readonly code = 'daemon_runtime_state_unavailable';
  readonly recoveryAction =
    'preserve the database and use an explicit verified recovery path';

  constructor(
    readonly stage: DaemonRuntimeStateStoreErrorStage,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DaemonRuntimeStateStoreError';
  }
}

interface DaemonRuntimeStateStoreStartupMigration {
  backupCreated: boolean;
  fromVersion: number;
  toVersion: number;
}

interface DaemonRuntimeStateStoreDiagnostics {
  foreignKeysEnabled: true;
  journalMode: 'wal';
  schemaVersion: number;
  startupHealth: 'ok';
  startupMigration: DaemonRuntimeStateStoreStartupMigration | null;
  synchronousMode: 'full';
}

export interface DaemonRuntimeStateStore
  extends
    SubagentLaunchRequestStore,
    SubagentTerminalDeliveryStore,
    McpSessionCoordinateStore {
  readonly databasePath: string;
  close(): void;
  readDiagnostics(): DaemonRuntimeStateStoreDiagnostics;
}

export function resolveDaemonRuntimeStateDatabasePath(
  homeStateRoot: string,
): string {
  if (!isAbsolute(homeStateRoot)) {
    throw new Error('daemon runtime-state home root must be an absolute path');
  }
  return joinWorkspaceGeulbatPath(homeStateRoot, RUNTIME_STATE_DATABASE_FILE);
}

export async function createDaemonRuntimeStateStore(args: {
  homeStateRoot: string;
  now?: (() => Date) | undefined;
}): Promise<DaemonRuntimeStateStore> {
  const databasePath = resolveDaemonRuntimeStateDatabasePath(
    args.homeStateRoot,
  );
  try {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    throw new DaemonRuntimeStateStoreError(
      'open',
      'daemon runtime-state directory could not be prepared',
      error,
    );
  }

  let databaseExistedBeforeOpen: boolean;
  try {
    databaseExistedBeforeOpen = await pathExists(databasePath);
  } catch (error: unknown) {
    throw new DaemonRuntimeStateStoreError(
      'open',
      'daemon runtime-state database could not be inspected',
      error,
    );
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, {
      allowBareNamedParameters: false,
      allowExtension: false,
      allowUnknownNamedParameters: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
  } catch (error: unknown) {
    throw new DaemonRuntimeStateStoreError(
      'open',
      'daemon runtime-state database could not be opened',
      error,
    );
  }
  let closed = false;
  let startupMigration: DaemonRuntimeStateStoreStartupMigration | null = null;
  const now = args.now ?? (() => new Date());

  try {
    runHealthCheck(database);
  } catch (error: unknown) {
    closeDatabase(database);
    throw new DaemonRuntimeStateStoreError(
      'health_check',
      'daemon runtime-state database failed its startup health check; the original database was preserved',
      error,
    );
  }

  let initialSchemaVersion: number;
  try {
    initialSchemaVersion = readSchemaVersion(database);
    if (initialSchemaVersion > RUNTIME_STATE_SCHEMA_VERSION) {
      throw new Error(
        `schema version ${initialSchemaVersion} is newer than supported version ${RUNTIME_STATE_SCHEMA_VERSION}`,
      );
    }
  } catch (error: unknown) {
    closeDatabase(database);
    throw new DaemonRuntimeStateStoreError(
      'compatibility',
      'daemon runtime-state database schema is not compatible with this daemon; the original database was preserved',
      error,
    );
  }

  let backupCreated = false;
  if (
    initialSchemaVersion < RUNTIME_STATE_SCHEMA_VERSION &&
    databaseExistedBeforeOpen
  ) {
    try {
      await createPreMigrationBackup({
        database,
        fromVersion: initialSchemaVersion,
        homeStateRoot: args.homeStateRoot,
        now,
      });
      backupCreated = true;
    } catch (error: unknown) {
      closeDatabase(database);
      throw new DaemonRuntimeStateStoreError(
        'backup',
        'daemon runtime-state pre-migration backup failed; migration did not start',
        error,
      );
    }
  }

  try {
    database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = FULL;
      `);
  } catch (error: unknown) {
    closeDatabase(database);
    throw new DaemonRuntimeStateStoreError(
      'configuration',
      'daemon runtime-state database policy could not be applied',
      error,
    );
  }

  if (initialSchemaVersion < RUNTIME_STATE_SCHEMA_VERSION) {
    try {
      runRuntimeStateMigrations({
        database,
        fromVersion: initialSchemaVersion,
        now,
      });
    } catch (error: unknown) {
      closeDatabase(database);
      throw new DaemonRuntimeStateStoreError(
        'migration',
        'daemon runtime-state migration failed; automatic legacy fallback is disabled',
        error,
      );
    }
    startupMigration = {
      backupCreated,
      fromVersion: initialSchemaVersion,
      toVersion: RUNTIME_STATE_SCHEMA_VERSION,
    };
  }

  try {
    runHealthCheck(database);
    validateMigrationHistory(database);
    readRuntimeStateStoreDiagnostics(database, startupMigration);
  } catch (error: unknown) {
    closeDatabase(database);
    throw new DaemonRuntimeStateStoreError(
      'compatibility',
      'daemon runtime-state database failed post-migration validation; the database and any backup were preserved',
      error,
    );
  }

  try {
    reconcileSubagentLaunchesAfterRestart(database, now);
  } catch (error: unknown) {
    closeDatabase(database);
    throw new DaemonRuntimeStateStoreError(
      'recovery',
      'daemon runtime-state restart reconciliation failed; active launch state was not partially recovered',
      error,
    );
  }

  return {
    databasePath,
    readMcpSessionCoordinate(serverId) {
      return runRuntimeStateStoreOperation(
        closed,
        'read MCP session coordinate',
        () => readMcpSessionCoordinate(database, serverId),
      );
    },
    persistMcpSessionCoordinate(coordinate) {
      runRuntimeStateStoreOperation(
        closed,
        'persist MCP session coordinate',
        () => persistMcpSessionCoordinate(database, coordinate),
      );
    },
    deleteMcpSessionCoordinate(serverId) {
      runRuntimeStateStoreOperation(
        closed,
        'delete MCP session coordinate',
        () => deleteMcpSessionCoordinate(database, serverId),
      );
    },
    enqueueSubagentLaunchBatch(requests) {
      return runRuntimeStateStoreOperation(
        closed,
        'enqueue subagent launch batch',
        () => enqueueSubagentLaunchBatch(database, requests, now),
      );
    },
    readSubagentLaunchRequest(readArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'read subagent launch request',
        () => readSubagentLaunchRequest(database, readArgs),
      );
    },
    readSubagentLaunchRequestByChildRunId(childRunId) {
      return runRuntimeStateStoreOperation(
        closed,
        'read subagent launch request by child run id',
        () => readSubagentLaunchRequestByChildRunId(database, childRunId),
      );
    },
    readQueuedSubagentLaunchRequests() {
      return runRuntimeStateStoreOperation(
        closed,
        'read queued subagent launch requests',
        () => readQueuedSubagentLaunchRequests(database),
      );
    },
    markSubagentLaunchDeferredBatch(deferArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'mark subagent launch batch deferred',
        () => markSubagentLaunchDeferredBatch(database, deferArgs, now),
      );
    },
    cancelQueuedSubagentLaunchRequest(controlArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'cancel queued subagent launch request',
        () => cancelQueuedSubagentLaunchRequest(database, controlArgs, now),
      );
    },
    updateQueuedSubagentLaunchPriority(controlArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'update queued subagent launch priority',
        () => updateQueuedSubagentLaunchPriority(database, controlArgs, now),
      );
    },
    retryInterruptedSubagentLaunch(retryArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'retry interrupted subagent launch',
        () => retryInterruptedSubagentLaunch(database, retryArgs, now),
      );
    },
    markSubagentLaunchStarting(childRunId) {
      runRuntimeStateStoreOperation(
        closed,
        'mark subagent launch starting',
        () =>
          transitionSubagentLaunchRequest(database, {
            childRunId,
            fromStates: ['queued'],
            toState: 'starting',
            failureReason: null,
            runtimePhase: 'starting',
            now,
          }),
      );
    },
    markSubagentLaunchStarted(childRunId) {
      runRuntimeStateStoreOperation(
        closed,
        'mark subagent launch started',
        () =>
          transitionSubagentLaunchRequest(database, {
            childRunId,
            fromStates: ['starting'],
            toState: 'started',
            failureReason: null,
            runtimePhase: 'provider_waiting',
            now,
          }),
      );
    },
    recordSubagentRuntimeObservation(observationArgs) {
      runRuntimeStateStoreOperation(
        closed,
        'record subagent runtime observation',
        () => recordSubagentRuntimeObservation(database, observationArgs),
      );
    },
    markSubagentLaunchFailedToStart({ childRunId, reason }) {
      runRuntimeStateStoreOperation(
        closed,
        'mark subagent launch failed to start',
        () =>
          transitionSubagentLaunchRequest(database, {
            childRunId,
            fromStates: ['queued', 'starting'],
            toState: 'failed_to_start',
            failureReason: reason,
            now,
          }),
      );
    },
    recordSubagentTerminalDelivery(recordArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'record subagent terminal delivery',
        () => recordSubagentTerminalDelivery(database, recordArgs, now),
      );
    },
    readPendingSubagentTerminalDeliveries(ownerThreadId) {
      return runRuntimeStateStoreOperation(
        closed,
        'read pending subagent terminal deliveries',
        () => readPendingSubagentTerminalDeliveries(database, ownerThreadId),
      );
    },
    readSubagentTerminalDeliveries(ownerThreadId) {
      return runRuntimeStateStoreOperation(
        closed,
        'read subagent terminal deliveries',
        () => readSubagentTerminalDeliveries(database, ownerThreadId),
      );
    },
    acknowledgeSubagentTerminalDeliveries(acknowledgeArgs) {
      runRuntimeStateStoreOperation(
        closed,
        'acknowledge subagent terminal deliveries',
        () =>
          acknowledgeSubagentTerminalDeliveries(database, acknowledgeArgs, now),
      );
    },
    clearSubagentTerminalDeliveries(ownerThreadId) {
      runRuntimeStateStoreOperation(
        closed,
        'clear subagent terminal deliveries',
        () => clearSubagentTerminalDeliveries(database, ownerThreadId),
      );
    },
    readSubagentTerminalOutcomeByChildRunId(childRunId) {
      return runRuntimeStateStoreOperation(
        closed,
        'read subagent terminal outcome by child run id',
        () => readSubagentTerminalOutcomeByChildRunId(database, childRunId),
      );
    },
    readSubagentTerminalOutcomeByResultRef(resultRef) {
      return runRuntimeStateStoreOperation(
        closed,
        'read subagent terminal outcome by result ref',
        () => readSubagentTerminalOutcomeByResultRef(database, resultRef),
      );
    },
    isSubagentResultReaderInOwnerScope(scopeArgs) {
      return runRuntimeStateStoreOperation(
        closed,
        'check subagent result reader owner scope',
        () => isSubagentResultReaderInOwnerScope(database, scopeArgs),
      );
    },
    close() {
      if (closed) {
        return;
      }
      database.close();
      closed = true;
    },
    readDiagnostics() {
      if (closed) {
        throw new Error('daemon runtime-state store is closed');
      }
      return readRuntimeStateStoreDiagnostics(database, startupMigration);
    },
  };
}

function readRuntimeStateStoreDiagnostics(
  database: DatabaseSync,
  startupMigration: DaemonRuntimeStateStoreStartupMigration | null,
): DaemonRuntimeStateStoreDiagnostics {
  const journalMode = readStringPragma(
    database,
    'PRAGMA journal_mode',
    'journal_mode',
  ).toLowerCase();
  const foreignKeys = readNumberPragma(
    database,
    'PRAGMA foreign_keys',
    'foreign_keys',
  );
  const synchronous = readNumberPragma(
    database,
    'PRAGMA synchronous',
    'synchronous',
  );
  const schemaVersion = readSchemaVersion(database);

  if (journalMode !== 'wal') {
    throw new Error(
      `daemon runtime-state journal mode is ${journalMode}; expected wal`,
    );
  }
  if (foreignKeys !== 1) {
    throw new Error('daemon runtime-state foreign keys are not enabled');
  }
  if (synchronous !== SQLITE_SYNCHRONOUS_FULL) {
    throw new Error(
      `daemon runtime-state synchronous mode is ${synchronous}; expected full`,
    );
  }

  return {
    foreignKeysEnabled: true,
    journalMode: 'wal',
    schemaVersion,
    startupHealth: 'ok',
    startupMigration,
    synchronousMode: 'full',
  };
}

function reconcileSubagentLaunchesAfterRestart(
  database: DatabaseSync,
  now: () => Date,
): void {
  const timestamp = now().toISOString();
  runImmediateTransaction(database, () => {
    database
      .prepare(
        `
          UPDATE subagent_launch_requests
          SET
            defer_reason = 'recovery_reconciliation',
            updated_at = ?
          WHERE launch_state = 'queued'
            AND (
              defer_reason IS NULL OR
              defer_reason <> 'recovery_reconciliation'
            )
        `,
      )
      .run(timestamp);

    const activeRows = database
      .prepare(
        `
          SELECT
            launch.child_run_id AS childRunId,
            launch.child_thread_id AS childThreadId,
            launch.parent_run_id AS parentRunId,
            launch.owner_thread_id AS ownerThreadId,
            launch.input_json AS inputJson
          FROM subagent_launch_requests AS launch
          WHERE launch.launch_state IN ('starting', 'started')
            AND NOT EXISTS (
              SELECT 1
              FROM subagent_terminal_outcomes AS terminal
              WHERE terminal.child_run_id = launch.child_run_id
            )
          ORDER BY launch.enqueue_order
        `,
      )
      .all();

    for (const rawRow of activeRows) {
      const row = parseSubagentRestartRecoveryRow(rawRow);
      const launch = readSubagentLaunchRequestByChildRunId(
        database,
        row.childRunId,
      );
      if (launch === undefined) {
        throw new Error(
          `subagent restart recovery lost launch ${row.childRunId}`,
        );
      }
      const result = parseBackgroundChildResult({
        deliveryId: randomUUID(),
        parentRunId: row.parentRunId,
        childRunId: row.childRunId,
        childThreadId: row.childThreadId,
        subagentType: row.subagentType,
        capabilities: row.capabilities,
        toolSurface: resolveSubagentToolSurfaceProfile({
          subagentType: row.subagentType,
          capabilities: row.capabilities,
        }),
        runtime: launch.runtime,
        terminalState: 'failed',
        reason: 'daemon_restart',
        result: DAEMON_RESTART_INTERRUPTION_RESULT,
        completedAt: timestamp,
        modelId: row.modelId,
        reasoningEffort: row.reasoningEffort,
      });
      recordSubagentTerminalDeliveryInTransaction(
        database,
        { ownerThreadId: row.ownerThreadId, result },
        timestamp,
      );
      const transition = database
        .prepare(
          `
            UPDATE subagent_launch_requests
            SET
              launch_state = 'interrupted',
              defer_reason = NULL,
              failure_reason = ?,
              updated_at = ?
            WHERE child_run_id = ?
              AND launch_state IN ('starting', 'started')
          `,
        )
        .run(DAEMON_RESTART_INTERRUPTION_REASON, timestamp, row.childRunId);
      if (Number(transition.changes) !== 1) {
        throw new Error(
          `subagent restart reconciliation lost active launch ${row.childRunId}`,
        );
      }
    }
  });
}

function parseSubagentRestartRecoveryRow(row: unknown): {
  childRunId: RunId;
  childThreadId: ThreadId;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  subagentType: SubagentLaunchRequestInput['subagentType'];
  capabilities: SubagentLaunchRequestInput['capabilities'];
  modelId: string;
  reasoningEffort: NonNullable<BackgroundChildResult['reasoningEffort']>;
} {
  if (
    !isRecord(row) ||
    typeof row['childRunId'] !== 'string' ||
    typeof row['childThreadId'] !== 'string' ||
    typeof row['parentRunId'] !== 'string' ||
    typeof row['ownerThreadId'] !== 'string' ||
    typeof row['inputJson'] !== 'string'
  ) {
    throw new Error('active subagent restart recovery row is invalid');
  }
  const input = parsePersistedSubagentLaunchInput(row['inputJson']);
  return {
    childRunId: assertRunId(row['childRunId']),
    childThreadId: assertThreadId(row['childThreadId']),
    parentRunId: assertRunId(row['parentRunId']),
    ownerThreadId: assertThreadId(row['ownerThreadId']),
    subagentType: input['subagentType'],
    capabilities: [...input['capabilities']],
    modelId: input['modelPin']['modelId'],
    reasoningEffort: input.modelPin.providerRunSelection.reasoningEffort,
  };
}
function runRuntimeStateStoreOperation<T>(
  closed: boolean,
  label: string,
  operation: () => T,
): T {
  if (closed) {
    throw new DaemonRuntimeStateStoreError(
      'operation',
      `daemon runtime-state store is closed; cannot ${label}`,
    );
  }
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof DaemonRuntimeStateStoreError) {
      throw error;
    }
    throw new DaemonRuntimeStateStoreError(
      'operation',
      `daemon runtime-state store could not ${label}`,
      error,
    );
  }
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}
