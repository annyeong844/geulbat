import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertRunId,
  assertThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import { isRunReasoningEffort } from '@geulbat/protocol/run-contract';
import {
  isRunUsageTotals,
  isSubagentCapabilities,
  isSubagentRuntimeDiagnostics,
  isSubagentToolSurfaceProfile,
  isSubagentType,
} from '@geulbat/protocol/run-events';
import {
  isAgentChildTerminalReason,
  isAgentChildTerminalState,
  isSubagentResultReport,
} from '@geulbat/protocol/subagent-terminal';

import { isRecord } from './runtime-json.js';
import type {
  BackgroundChildResult,
  BackgroundChildResultInput,
  DurableSubagentTerminalOutcome,
  SubagentTerminalDeliveryRecord,
} from './subagent-runtime-contracts.js';
import { runImmediateTransaction } from './runtime-state-database.js';

export function recordSubagentTerminalDelivery(
  database: DatabaseSync,
  args: {
    ownerThreadId: ThreadId;
    result: BackgroundChildResultInput;
  },
  now: () => Date,
): SubagentTerminalDeliveryRecord {
  const ownerThreadId = assertThreadId(args.ownerThreadId);
  const parsedResult = parseBackgroundChildResult(args.result);
  const resultRef = buildSubagentTerminalResultRef(parsedResult.deliveryId);
  const resultDigest = buildSubagentResultDigest(parsedResult.result);
  const resultReportSummary = args.result.resultReportSummary;
  if (resultReportSummary !== undefined && resultReportSummary.trim() === '') {
    throw new Error('subagent result report summary is invalid');
  }
  const result: BackgroundChildResult =
    resultReportSummary === undefined
      ? parsedResult
      : {
          ...parsedResult,
          resultReport: {
            summary: resultReportSummary,
            sourceResultRef: resultRef,
            sourceResultDigest: resultDigest,
          },
        };

  return runImmediateTransaction(database, () =>
    recordSubagentTerminalDeliveryInTransaction(
      database,
      { ownerThreadId, result },
      now().toISOString(),
    ),
  );
}

export function recordSubagentTerminalDeliveryInTransaction(
  database: DatabaseSync,
  args: {
    ownerThreadId: ThreadId;
    result: BackgroundChildResult;
  },
  timestamp: string,
): SubagentTerminalDeliveryRecord {
  const { ownerThreadId, result } = args;
  const payloadJson = JSON.stringify(result);
  const resultRef = buildSubagentTerminalResultRef(result.deliveryId);

  const existing = readSubagentTerminalOutcomeByChildRunId(
    database,
    result.childRunId,
  );
  if (existing !== undefined) {
    if (
      existing.ownerThreadId !== ownerThreadId ||
      existing.resultRef !== resultRef ||
      JSON.stringify(existing.result) !== payloadJson
    ) {
      throw new Error(
        `subagent terminal outcome conflicts with child run ${result.childRunId}`,
      );
    }
    return { inserted: false, outcome: existing };
  }

  database
    .prepare(
      `
          INSERT INTO subagent_terminal_outcomes (
            child_run_id,
            owner_thread_id,
            parent_run_id,
            child_thread_id,
            result_ref,
            terminal_state,
            terminal_reason,
            completed_at,
            result_bytes,
            payload_json,
            recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
    )
    .run(
      result.childRunId,
      ownerThreadId,
      result.parentRunId,
      result.childThreadId ?? null,
      resultRef,
      result.terminalState,
      result.reason ?? null,
      result.completedAt,
      Buffer.byteLength(result.result, 'utf8'),
      payloadJson,
      timestamp,
    );
  database
    .prepare(
      `
          INSERT INTO subagent_background_deliveries (
            delivery_id,
            owner_thread_id,
            child_run_id,
            acknowledged_at,
            created_at
          ) VALUES (?, ?, ?, NULL, ?)
        `,
    )
    .run(result.deliveryId, ownerThreadId, result.childRunId, timestamp);

  const outcome = readSubagentTerminalOutcomeByChildRunId(
    database,
    result.childRunId,
  );
  if (outcome === undefined) {
    throw new Error(
      `recorded subagent terminal outcome disappeared: ${result.childRunId}`,
    );
  }
  return { inserted: true, outcome };
}

export function readPendingSubagentTerminalDeliveries(
  database: DatabaseSync,
  ownerThreadId: ThreadId,
): readonly DurableSubagentTerminalOutcome[] {
  const owner = assertThreadId(ownerThreadId);
  const rows = database
    .prepare(
      `
        SELECT
          deliveries.delivery_id AS deliveryId,
          outcomes.child_run_id AS childRunId,
          outcomes.owner_thread_id AS ownerThreadId,
          outcomes.parent_run_id AS parentRunId,
          outcomes.child_thread_id AS childThreadId,
          outcomes.result_ref AS resultRef,
          outcomes.terminal_state AS terminalState,
          outcomes.terminal_reason AS terminalReason,
          outcomes.completed_at AS completedAt,
          outcomes.result_bytes AS resultBytes,
          outcomes.payload_json AS payloadJson,
          deliveries.acknowledged_at AS acknowledgedAt
        FROM subagent_background_deliveries AS deliveries
        JOIN subagent_terminal_outcomes AS outcomes
          ON outcomes.child_run_id = deliveries.child_run_id
        WHERE deliveries.owner_thread_id = ?
          AND deliveries.acknowledged_at IS NULL
        ORDER BY deliveries.created_at, deliveries.delivery_id
      `,
    )
    .all(owner);
  return rows.map(parseSubagentTerminalOutcomeRow);
}

export function readSubagentTerminalDeliveries(
  database: DatabaseSync,
  ownerThreadId: ThreadId,
): readonly DurableSubagentTerminalOutcome[] {
  const owner = assertThreadId(ownerThreadId);
  const rows = database
    .prepare(
      `
        SELECT
          deliveries.delivery_id AS deliveryId,
          outcomes.child_run_id AS childRunId,
          outcomes.owner_thread_id AS ownerThreadId,
          outcomes.parent_run_id AS parentRunId,
          outcomes.child_thread_id AS childThreadId,
          outcomes.result_ref AS resultRef,
          outcomes.terminal_state AS terminalState,
          outcomes.terminal_reason AS terminalReason,
          outcomes.completed_at AS completedAt,
          outcomes.result_bytes AS resultBytes,
          outcomes.payload_json AS payloadJson,
          deliveries.acknowledged_at AS acknowledgedAt
        FROM subagent_background_deliveries AS deliveries
        JOIN subagent_terminal_outcomes AS outcomes
          ON outcomes.child_run_id = deliveries.child_run_id
        WHERE deliveries.owner_thread_id = ?
        ORDER BY deliveries.created_at, deliveries.delivery_id
      `,
    )
    .all(owner);
  return rows.map(parseSubagentTerminalOutcomeRow);
}

export function acknowledgeSubagentTerminalDeliveries(
  database: DatabaseSync,
  args: {
    ownerThreadId: ThreadId;
    deliveryIds: readonly string[];
  },
  now: () => Date,
): void {
  if (args.deliveryIds.length === 0) {
    return;
  }
  const ownerThreadId = assertThreadId(args.ownerThreadId);
  const deliveryIds = [...new Set(args.deliveryIds)];
  if (deliveryIds.some((deliveryId) => deliveryId.trim() === '')) {
    throw new Error('subagent terminal delivery id must not be empty');
  }
  const update = database.prepare(`
    UPDATE subagent_background_deliveries
    SET acknowledged_at = ?
    WHERE owner_thread_id = ?
      AND delivery_id = ?
      AND acknowledged_at IS NULL
  `);
  const timestamp = now().toISOString();
  runImmediateTransaction(database, () => {
    for (const deliveryId of deliveryIds) {
      update.run(timestamp, ownerThreadId, deliveryId);
    }
  });
}

export function clearSubagentTerminalDeliveries(
  database: DatabaseSync,
  ownerThreadId: ThreadId,
): void {
  database
    .prepare('DELETE FROM subagent_terminal_outcomes WHERE owner_thread_id = ?')
    .run(assertThreadId(ownerThreadId));
}

export function readSubagentTerminalOutcomeByChildRunId(
  database: DatabaseSync,
  childRunId: RunId,
): DurableSubagentTerminalOutcome | undefined {
  const row = database
    .prepare(
      `
        SELECT
          deliveries.delivery_id AS deliveryId,
          outcomes.child_run_id AS childRunId,
          outcomes.owner_thread_id AS ownerThreadId,
          outcomes.parent_run_id AS parentRunId,
          outcomes.child_thread_id AS childThreadId,
          outcomes.result_ref AS resultRef,
          outcomes.terminal_state AS terminalState,
          outcomes.terminal_reason AS terminalReason,
          outcomes.completed_at AS completedAt,
          outcomes.result_bytes AS resultBytes,
          outcomes.payload_json AS payloadJson,
          deliveries.acknowledged_at AS acknowledgedAt
        FROM subagent_terminal_outcomes AS outcomes
        JOIN subagent_background_deliveries AS deliveries
          ON deliveries.child_run_id = outcomes.child_run_id
        WHERE outcomes.child_run_id = ?
      `,
    )
    .get(assertRunId(childRunId));
  return row === undefined ? undefined : parseSubagentTerminalOutcomeRow(row);
}

export function readSubagentTerminalOutcomeByResultRef(
  database: DatabaseSync,
  resultRef: string,
): DurableSubagentTerminalOutcome | undefined {
  const row = database
    .prepare(
      `
        SELECT
          deliveries.delivery_id AS deliveryId,
          outcomes.child_run_id AS childRunId,
          outcomes.owner_thread_id AS ownerThreadId,
          outcomes.parent_run_id AS parentRunId,
          outcomes.child_thread_id AS childThreadId,
          outcomes.result_ref AS resultRef,
          outcomes.terminal_state AS terminalState,
          outcomes.terminal_reason AS terminalReason,
          outcomes.completed_at AS completedAt,
          outcomes.result_bytes AS resultBytes,
          outcomes.payload_json AS payloadJson,
          deliveries.acknowledged_at AS acknowledgedAt
        FROM subagent_terminal_outcomes AS outcomes
        JOIN subagent_background_deliveries AS deliveries
          ON deliveries.child_run_id = outcomes.child_run_id
        WHERE outcomes.result_ref = ?
      `,
    )
    .get(resultRef);
  return row === undefined ? undefined : parseSubagentTerminalOutcomeRow(row);
}

export function isSubagentResultReaderInOwnerScope(
  database: DatabaseSync,
  args: {
    ownerThreadId: ThreadId;
    parentRunId: RunId;
    readerThreadId: ThreadId;
  },
): boolean {
  const ownerThreadId = assertThreadId(args.ownerThreadId);
  const readerThreadId = assertThreadId(args.readerThreadId);
  if (readerThreadId === ownerThreadId) {
    return true;
  }
  return (
    database
      .prepare(
        `
          SELECT 1 AS admitted
          FROM subagent_launch_requests
          WHERE owner_thread_id = ?
            AND parent_run_id = ?
            AND child_thread_id = ?
          LIMIT 1
        `,
      )
      .get(ownerThreadId, assertRunId(args.parentRunId), readerThreadId) !==
    undefined
  );
}

function parseSubagentTerminalOutcomeRow(
  row: unknown,
): DurableSubagentTerminalOutcome {
  if (
    !isRecord(row) ||
    typeof row['deliveryId'] !== 'string' ||
    typeof row['childRunId'] !== 'string' ||
    typeof row['ownerThreadId'] !== 'string' ||
    typeof row['parentRunId'] !== 'string' ||
    (row['childThreadId'] !== null &&
      typeof row['childThreadId'] !== 'string') ||
    typeof row['resultRef'] !== 'string' ||
    !isAgentChildTerminalState(row['terminalState']) ||
    (row['terminalReason'] !== null &&
      !isAgentChildTerminalReason(row['terminalReason'])) ||
    typeof row['completedAt'] !== 'string' ||
    typeof row['resultBytes'] !== 'number' ||
    !Number.isSafeInteger(row['resultBytes']) ||
    row['resultBytes'] < 0 ||
    typeof row['payloadJson'] !== 'string' ||
    (row['acknowledgedAt'] !== null &&
      (typeof row['acknowledgedAt'] !== 'string' ||
        row['acknowledgedAt'].trim() === ''))
  ) {
    throw new Error('subagent terminal outcome row is invalid');
  }

  const ownerThreadId = assertThreadId(row['ownerThreadId']);
  const childRunId = assertRunId(row['childRunId']);
  const parentRunId = assertRunId(row['parentRunId']);
  const childThreadId =
    row['childThreadId'] === null
      ? undefined
      : assertThreadId(row['childThreadId']);
  const result = parseBackgroundChildResult(JSON.parse(row['payloadJson']));
  const resultDigest = buildSubagentResultDigest(result.result);
  const terminalReason = row['terminalReason'];
  if (
    result.deliveryId !== row['deliveryId'] ||
    result.childRunId !== childRunId ||
    result.parentRunId !== parentRunId ||
    result.childThreadId !== childThreadId ||
    result.terminalState !== row['terminalState'] ||
    (result.reason ?? null) !== terminalReason ||
    result.completedAt !== row['completedAt'] ||
    Buffer.byteLength(result.result, 'utf8') !== row['resultBytes'] ||
    row['resultRef'] !== buildSubagentTerminalResultRef(result.deliveryId) ||
    (result.resultReport !== undefined &&
      (result.resultReport.sourceResultRef !== row['resultRef'] ||
        result.resultReport.sourceResultDigest !== resultDigest))
  ) {
    throw new Error('subagent terminal outcome metadata does not match body');
  }
  return {
    ownerThreadId,
    resultDeliveryState:
      row['acknowledgedAt'] === null ? 'pending' : 'acknowledged',
    resultRef: row['resultRef'],
    resultDigest,
    result,
  };
}

export function parseBackgroundChildResult(
  value: unknown,
): BackgroundChildResult {
  if (
    !isRecord(value) ||
    typeof value['deliveryId'] !== 'string' ||
    value['deliveryId'].trim() === '' ||
    typeof value['parentRunId'] !== 'string' ||
    typeof value['childRunId'] !== 'string' ||
    (value['childThreadId'] !== undefined &&
      typeof value['childThreadId'] !== 'string') ||
    !isSubagentType(value['subagentType']) ||
    (value['capabilities'] !== undefined &&
      !isSubagentCapabilities(value['capabilities'])) ||
    (value['toolSurface'] !== undefined &&
      !isSubagentToolSurfaceProfile(value['toolSurface'])) ||
    (value['runtime'] !== undefined &&
      !isSubagentRuntimeDiagnostics(value['runtime'])) ||
    !isAgentChildTerminalState(value['terminalState']) ||
    (value['reason'] !== undefined &&
      !isAgentChildTerminalReason(value['reason'])) ||
    typeof value['result'] !== 'string' ||
    typeof value['completedAt'] !== 'string' ||
    value['completedAt'].trim() === '' ||
    (value['elapsedMs'] !== undefined &&
      (typeof value['elapsedMs'] !== 'number' ||
        !Number.isFinite(value['elapsedMs']) ||
        value['elapsedMs'] < 0)) ||
    (value['usage'] !== undefined && !isRunUsageTotals(value['usage'])) ||
    (value['modelId'] !== undefined &&
      (typeof value['modelId'] !== 'string' ||
        value['modelId'].trim() === '')) ||
    (value['reasoningEffort'] !== undefined &&
      !isRunReasoningEffort(value['reasoningEffort'])) ||
    (value['resultReport'] !== undefined &&
      !isSubagentResultReport(value['resultReport']))
  ) {
    throw new Error('subagent terminal outcome body is invalid');
  }

  return {
    deliveryId: value['deliveryId'],
    parentRunId: assertRunId(value['parentRunId']),
    childRunId: assertRunId(value['childRunId']),
    ...(value['childThreadId'] === undefined
      ? {}
      : { childThreadId: assertThreadId(value['childThreadId']) }),
    subagentType: value['subagentType'],
    ...(value['capabilities'] === undefined
      ? {}
      : { capabilities: [...value['capabilities']] }),
    ...(value['toolSurface'] === undefined
      ? {}
      : { toolSurface: value['toolSurface'] }),
    ...(value['runtime'] === undefined
      ? {}
      : {
          runtime: {
            ...value['runtime'],
            ...(value['runtime'].lastTool === undefined
              ? {}
              : { lastTool: { ...value['runtime'].lastTool } }),
            ...(value['runtime'].providerRequest === undefined
              ? {}
              : {
                  providerRequest: {
                    ...value['runtime'].providerRequest,
                    ...(value['runtime'].providerRequest.retry === undefined
                      ? {}
                      : {
                          retry: {
                            ...value['runtime'].providerRequest.retry,
                          },
                        }),
                  },
                }),
          },
        }),
    terminalState: value['terminalState'],
    ...(value['reason'] === undefined ? {} : { reason: value['reason'] }),
    result: value['result'],
    completedAt: value['completedAt'],
    ...(value['elapsedMs'] === undefined
      ? {}
      : { elapsedMs: value['elapsedMs'] }),
    ...(value['usage'] === undefined ? {} : { usage: value['usage'] }),
    ...(value['modelId'] === undefined ? {} : { modelId: value['modelId'] }),
    ...(value['reasoningEffort'] === undefined
      ? {}
      : { reasoningEffort: value['reasoningEffort'] }),
    ...(value['resultReport'] === undefined
      ? {}
      : { resultReport: { ...value['resultReport'] } }),
  };
}

function buildSubagentResultDigest(result: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(result).digest('hex')}`;
}

function buildSubagentTerminalResultRef(deliveryId: string): string {
  return `subagent-result:${deliveryId}`;
}
