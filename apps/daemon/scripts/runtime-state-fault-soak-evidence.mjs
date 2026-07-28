import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

function formatRuntimeStateFaultError(error) {
  const parts = [];
  let current = error;
  while (current !== undefined && current !== null) {
    if (typeof current !== 'object') {
      parts.push(String(current));
      break;
    }
    const name = typeof current.name === 'string' ? current.name : undefined;
    const message =
      typeof current.message === 'string' ? current.message : undefined;
    const code = typeof current.code === 'string' ? current.code : undefined;
    parts.push(
      [name, message, code === undefined ? undefined : `code=${code}`]
        .filter(Boolean)
        .join(': '),
    );
    current = current.cause;
  }
  return parts.filter(Boolean).join(' <- ');
}

async function readPathBytes(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function readRuntimeStateFaultSoakEvidence(databasePath, batchSize) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const quickCheck = database
      .prepare('PRAGMA quick_check')
      .all()
      .map((row) => row.quick_check);
    const schemaVersion = database
      .prepare('PRAGMA user_version')
      .get().user_version;
    const totalRows = database
      .prepare('SELECT COUNT(*) AS count FROM subagent_launch_requests')
      .get().count;
    const rollbackResidueCount = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM subagent_launch_requests
         WHERE tool_call_id LIKE 'rollback-probe-%'`,
      )
      .get().count;
    const incompleteBatchCount = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT batch_id
           FROM subagent_launch_requests
           WHERE batch_id IS NOT NULL
           GROUP BY batch_id
           HAVING COUNT(*) <> ?
             OR MIN(batch_position) <> 0
             OR MAX(batch_position) <> ?
         )`,
      )
      .get(batchSize, batchSize - 1).count;
    const duplicateIdentityGroupCount = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT parent_run_id, tool_call_id
           FROM subagent_launch_requests
           GROUP BY parent_run_id, tool_call_id
           HAVING COUNT(*) > 1
         )`,
      )
      .get().count;
    const launchStates = Object.fromEntries(
      database
        .prepare(
          `SELECT launch_state AS state, COUNT(*) AS count
           FROM subagent_launch_requests
           GROUP BY launch_state
           ORDER BY launch_state`,
        )
        .all()
        .map((row) => [row.state, row.count]),
    );
    return {
      duplicateIdentityGroupCount,
      incompleteBatchCount,
      launchStates,
      quickCheck,
      rollbackResidueCount,
      schemaVersion,
      totalRows,
    };
  } finally {
    database.close();
  }
}

function collectRuntimeStateFaultSoakFailures({
  config,
  databaseEvidence,
  deliberateDeaths,
  elapsedMs,
  failures,
  forcedShutdowns,
  initialDiagnostics,
  observedWorkerStats,
  reopenAttempts,
  reopenSuccesses,
  replacements,
}) {
  const result = [...failures];
  if (elapsedMs < config.durationMs) {
    result.push(
      `elapsed ${elapsedMs}ms was shorter than requested ${config.durationMs}ms`,
    );
  }
  if (deliberateDeaths < 1 || replacements !== deliberateDeaths) {
    result.push(
      `death/replacement mismatch: deaths=${deliberateDeaths}, replacements=${replacements}`,
    );
  }
  if (reopenSuccesses < 1 || reopenSuccesses !== reopenAttempts) {
    result.push(
      `store reopen mismatch: attempts=${reopenAttempts}, successes=${reopenSuccesses}`,
    );
  }
  if (observedWorkerStats.rollbackVerified < 1) {
    result.push('no transactional rollback was observed');
  }
  if (observedWorkerStats.unexpectedFailures !== 0) {
    result.push(
      `workers reported ${observedWorkerStats.unexpectedFailures} unexpected failures`,
    );
  }
  if (
    databaseEvidence.quickCheck.length !== 1 ||
    databaseEvidence.quickCheck[0] !== 'ok'
  ) {
    result.push(
      `SQLite quick_check failed: ${databaseEvidence.quickCheck.join(', ')}`,
    );
  }
  if (databaseEvidence.schemaVersion !== initialDiagnostics.schemaVersion) {
    result.push(
      `schema changed from ${initialDiagnostics.schemaVersion} to ${databaseEvidence.schemaVersion}`,
    );
  }
  if (
    databaseEvidence.incompleteBatchCount !== 0 ||
    databaseEvidence.rollbackResidueCount !== 0 ||
    databaseEvidence.duplicateIdentityGroupCount !== 0
  ) {
    result.push(
      'durable rows contain an incomplete batch, rollback residue, or duplicate identity',
    );
  }
  if (
    Object.keys(databaseEvidence.launchStates).some(
      (state) => state !== 'queued',
    )
  ) {
    result.push(
      `probe rows did not remain recoverable queued state: ${JSON.stringify(databaseEvidence.launchStates)}`,
    );
  }
  if (forcedShutdowns !== 0) {
    result.push(
      `forced worker shutdowns remained necessary: ${forcedShutdowns}`,
    );
  }
  return result;
}

export const runtimeStateFaultEvidence = {
  collectFailures: collectRuntimeStateFaultSoakFailures,
  formatError: formatRuntimeStateFaultError,
  readPathBytes,
  readRuntimeStateFaultSoakEvidence,
};
