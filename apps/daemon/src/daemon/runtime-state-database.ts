/**
 * 런타임 상태 DB의 "열기 수준" 관심사 — 스키마 사다리 적용, 사전 백업,
 * 무결성 점검, pragma·트랜잭션 원시 조작.
 *
 * runtime-state-store.ts에서 분리했다(2026-07-25). 사다리는 정의상 동결된
 * 이력이라(적용된 단계는 다시 바뀌지 않는다) 매번 읽고 고치는 런타임 API와
 * 수명이 다르다. 한 파일에 두면 살아있는 코드가 과거 이력에 파묻힌다. 같은
 * 이유로 DDL 본문은 runtime-state-migration-ladder.ts가 따로 소유하고,
 * 이 파일은 그것을 적용하는 방법만 안다.
 *
 * 새 스키마 단계는 사다리 끝에 항목을 붙이기만 하면 된다 — 버전 상수는
 * 사다리에서 파생되고, 기존 항목은 절대 수정하지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';

import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';
import { isRecord } from './runtime-json.js';
import { RUNTIME_STATE_MIGRATION_LADDER } from './runtime-state-migration-ladder.js';

/**
 * 사다리 길이가 곧 지원 스키마 버전이다. 별도 상수로 두면 단계를 더하면서
 * 버전 올리기를 잊는 어긋남이 생길 수 있어 파생값으로 둔다.
 */
export const RUNTIME_STATE_SCHEMA_VERSION =
  RUNTIME_STATE_MIGRATION_LADDER.length;
const RUNTIME_STATE_BACKUP_DIRECTORY = 'runtime-state-backups';

export function runRuntimeStateMigrations(args: {
  database: DatabaseSync;
  fromVersion: number;
  now: () => Date;
}): void {
  let currentVersion = args.fromVersion;
  while (currentVersion < RUNTIME_STATE_SCHEMA_VERSION) {
    // 인덱스가 곧 출발 버전이다. 사다리에 없는 버전에서 시작했다면 이 DB는 이
    // 빌드가 올릴 수 있는 이력 위에 있지 않다.
    const stepSql = RUNTIME_STATE_MIGRATION_LADDER[currentVersion];
    if (stepSql === undefined) {
      throw new Error(
        `no runtime-state migration starts at schema version ${currentVersion}`,
      );
    }
    const nextVersion = currentVersion + 1;
    runImmediateTransaction(args.database, () => {
      args.database.exec(stepSql);
      args.database
        .prepare(
          'INSERT INTO runtime_schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(nextVersion, args.now().toISOString());
      args.database.exec(`PRAGMA user_version = ${nextVersion};`);
    });
    currentVersion = nextVersion;
  }
}

export function runImmediateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = operation();
    database.exec('COMMIT;');
    return result;
  } catch (error: unknown) {
    if (database.isTransaction) {
      database.exec('ROLLBACK;');
    }
    throw error;
  }
}

export async function createPreMigrationBackup(args: {
  database: DatabaseSync;
  fromVersion: number;
  homeStateRoot: string;
  now: () => Date;
}): Promise<void> {
  const backupDirectory = joinWorkspaceGeulbatPath(
    args.homeStateRoot,
    RUNTIME_STATE_BACKUP_DIRECTORY,
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const timestamp = args
    .now()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');
  const backupPath = joinWorkspaceGeulbatPath(
    args.homeStateRoot,
    RUNTIME_STATE_BACKUP_DIRECTORY,
    `runtime-state-v${args.fromVersion}-to-v${RUNTIME_STATE_SCHEMA_VERSION}-${timestamp}-${randomUUID()}.sqlite3`,
  );

  await backup(args.database, backupPath);

  const backupDatabase = new DatabaseSync(backupPath);
  try {
    backupDatabase.exec('PRAGMA journal_mode = DELETE;');
    runHealthCheck(backupDatabase);
    const backupVersion = readSchemaVersion(backupDatabase);
    if (backupVersion !== args.fromVersion) {
      throw new Error(
        `pre-migration backup schema version ${backupVersion} does not match source version ${args.fromVersion}`,
      );
    }
  } finally {
    backupDatabase.close();
  }
}

export function validateMigrationHistory(database: DatabaseSync): void {
  const rows: readonly unknown[] = database
    .prepare(
      'SELECT version, applied_at AS appliedAt FROM runtime_schema_migrations ORDER BY version',
    )
    .all();
  if (rows.length !== RUNTIME_STATE_SCHEMA_VERSION) {
    throw new Error(
      `runtime-state migration history has ${rows.length} rows; expected ${RUNTIME_STATE_SCHEMA_VERSION}`,
    );
  }
  for (const [index, row] of rows.entries()) {
    if (
      !isRecord(row) ||
      row['version'] !== index + 1 ||
      typeof row['appliedAt'] !== 'string' ||
      row['appliedAt'].length === 0
    ) {
      throw new Error('runtime-state migration history is invalid');
    }
  }
}

export function runHealthCheck(database: DatabaseSync): void {
  const rows: readonly unknown[] = database.prepare('PRAGMA quick_check').all();
  if (
    rows.length !== 1 ||
    !isRecord(rows[0]) ||
    rows[0]['quick_check'] !== 'ok'
  ) {
    throw new Error('runtime-state quick_check did not return ok');
  }
}

export function readSchemaVersion(database: DatabaseSync): number {
  const version = readNumberPragma(
    database,
    'PRAGMA user_version',
    'user_version',
  );
  if (version < 0) {
    throw new Error('runtime-state schema version must be non-negative');
  }
  return version;
}

export function closeDatabase(database: DatabaseSync): void {
  if (database.isOpen) {
    database.close();
  }
}

export function readStringPragma(
  database: DatabaseSync,
  sql: string,
  field: string,
): string {
  const value = readPragma(database, sql, field);
  if (typeof value !== 'string') {
    throw new Error(`daemon runtime-state pragma ${field} is not a string`);
  }
  return value;
}

export function readNumberPragma(
  database: DatabaseSync,
  sql: string,
  field: string,
): number {
  const value = readPragma(database, sql, field);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`daemon runtime-state pragma ${field} is not an integer`);
  }
  return value;
}

function readPragma(
  database: DatabaseSync,
  sql: string,
  field: string,
): unknown {
  const row: unknown = database.prepare(sql).get();
  if (!isRecord(row) || !Object.hasOwn(row, field)) {
    throw new Error(`daemon runtime-state pragma ${field} returned no value`);
  }
  return row[field];
}
