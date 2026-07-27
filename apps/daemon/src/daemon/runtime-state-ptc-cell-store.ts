import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  type PtcExecuteCodeCellCoordinate,
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeRunningExecDelivery,
  type PtcExecuteCodeRunningWaitDelivery,
  type PtcSessionDockerSdkProjectionMount,
} from './ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { runImmediateTransaction } from './runtime-state-database.js';
import { isRecord } from './runtime-json.js';

export function listPtcExecuteCodeCellCoordinates(
  database: DatabaseSync,
): PtcExecuteCodeCellCoordinate[] {
  const rows: readonly unknown[] = database
    .prepare(
      `
        SELECT
          cell_id AS cellId,
          state_root AS stateRoot,
          thread_id AS threadId,
          created_at_ms AS createdAtMs,
          effective_timeout_ms AS effectiveTimeoutMs,
          orphan_reap_at_ms AS orphanReapAtMs,
          process_output_ref AS processOutputRef,
          callback_output_ref AS callbackOutputRef,
          identity_json AS identityJson,
          container_id AS containerId,
          max_buffered_bytes_per_stream AS maxBufferedBytesPerStream,
          callback_tool_names_json AS callbackToolNamesJson,
          store_callbacks_enabled AS storeCallbacksEnabled,
          stdout_read_offset_bytes AS stdoutReadOffsetBytes,
          stderr_read_offset_bytes AS stderrReadOffsetBytes
        FROM ptc_execute_code_cell_coordinates
        ORDER BY created_at_ms, cell_id
      `,
    )
    .all();
  return rows.map(parseCoordinateRow);
}

export function persistPtcExecuteCodeCellCoordinate(
  database: DatabaseSync,
  coordinate: PtcExecuteCodeCellCoordinate,
): void {
  validateCoordinate(coordinate);
  database
    .prepare(
      `
        INSERT INTO ptc_execute_code_cell_coordinates (
          cell_id,
          state_root,
          thread_id,
          created_at_ms,
          effective_timeout_ms,
          orphan_reap_at_ms,
          process_output_ref,
          callback_output_ref,
          identity_json,
          container_id,
          max_buffered_bytes_per_stream,
          callback_tool_names_json,
          store_callbacks_enabled,
          stdout_read_offset_bytes,
          stderr_read_offset_bytes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cell_id) DO UPDATE SET
          state_root = excluded.state_root,
          thread_id = excluded.thread_id,
          created_at_ms = excluded.created_at_ms,
          effective_timeout_ms = excluded.effective_timeout_ms,
          orphan_reap_at_ms = excluded.orphan_reap_at_ms,
          process_output_ref = excluded.process_output_ref,
          callback_output_ref = excluded.callback_output_ref,
          identity_json = excluded.identity_json,
          container_id = excluded.container_id,
          max_buffered_bytes_per_stream =
            excluded.max_buffered_bytes_per_stream,
          callback_tool_names_json = excluded.callback_tool_names_json,
          store_callbacks_enabled = excluded.store_callbacks_enabled,
          stdout_read_offset_bytes = excluded.stdout_read_offset_bytes,
          stderr_read_offset_bytes = excluded.stderr_read_offset_bytes
      `,
    )
    .run(
      coordinate.cellId,
      coordinate.stateRoot,
      coordinate.threadId,
      coordinate.createdAtMs,
      coordinate.effectiveTimeoutMs,
      coordinate.orphanReapAtMs ?? null,
      coordinate.processOutputRef,
      coordinate.callbackOutputRef ?? null,
      JSON.stringify({
        trustContextId: coordinate.trustContextId,
        ...(coordinate.ephemeralBurstId === undefined
          ? {}
          : { ephemeralBurstId: coordinate.ephemeralBurstId }),
        ...(coordinate.sdkProjectionMount === undefined
          ? {}
          : { sdkProjectionMount: coordinate.sdkProjectionMount }),
      }),
      coordinate.containerId,
      coordinate.maxBufferedBytesPerStream,
      JSON.stringify(coordinate.callbackToolNames),
      coordinate.storeCallbacksEnabled ? 1 : 0,
      coordinate.outputReadOffsets?.stdoutBytes ?? null,
      coordinate.outputReadOffsets?.stderrBytes ?? null,
    );
}

export function deletePtcExecuteCodeCellCoordinate(
  database: DatabaseSync,
  cellId: PtcExecuteCodeCellId,
): void {
  assertCellId(cellId);
  database
    .prepare('DELETE FROM ptc_execute_code_cell_coordinates WHERE cell_id = ?')
    .run(cellId);
}

export function readPtcExecuteCodeRunningWaitDelivery(
  database: DatabaseSync,
  args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  },
): PtcExecuteCodeRunningWaitDelivery | undefined {
  assertNonEmpty(args.threadId, 'threadId');
  assertCellId(args.cellId);
  const row: unknown = database
    .prepare(
      `
        SELECT
          thread_id AS threadId,
          cell_id AS cellId,
          run_id AS runId,
          call_id AS callId,
          stdout,
          stderr,
          stdout_read_offset_bytes AS stdoutReadOffsetBytes,
          stderr_read_offset_bytes AS stderrReadOffsetBytes
        FROM ptc_execute_code_running_wait_deliveries
        WHERE thread_id = ? AND cell_id = ?
      `,
    )
    .get(args.threadId, args.cellId);
  return row === undefined ? undefined : parseRunningWaitDeliveryRow(row);
}

export function persistPtcExecuteCodeRunningWaitDelivery(
  database: DatabaseSync,
  delivery: PtcExecuteCodeRunningWaitDelivery,
): void {
  validateRunningWaitDelivery(delivery);
  runImmediateTransaction(database, () => {
    const updated = database
      .prepare(
        `
          UPDATE ptc_execute_code_cell_coordinates
          SET
            stdout_read_offset_bytes = ?,
            stderr_read_offset_bytes = ?
          WHERE cell_id = ? AND thread_id = ?
        `,
      )
      .run(
        delivery.outputReadOffsets.stdoutBytes,
        delivery.outputReadOffsets.stderrBytes,
        delivery.cellId,
        delivery.threadId,
      );
    if (updated.changes !== 1) {
      throw new Error(
        'PTC running wait delivery requires a matching live cell coordinate',
      );
    }
    database
      .prepare(
        `
          INSERT INTO ptc_execute_code_running_wait_deliveries (
            thread_id,
            cell_id,
            run_id,
            call_id,
            stdout,
            stderr,
            stdout_read_offset_bytes,
            stderr_read_offset_bytes
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, cell_id) DO UPDATE SET
            run_id = excluded.run_id,
            call_id = excluded.call_id,
            stdout = excluded.stdout,
            stderr = excluded.stderr,
            stdout_read_offset_bytes = excluded.stdout_read_offset_bytes,
            stderr_read_offset_bytes = excluded.stderr_read_offset_bytes
        `,
      )
      .run(
        delivery.threadId,
        delivery.cellId,
        delivery.runId,
        delivery.callId,
        delivery.stdout,
        delivery.stderr,
        delivery.outputReadOffsets.stdoutBytes,
        delivery.outputReadOffsets.stderrBytes,
      );
  });
}

export function deletePtcExecuteCodeRunningWaitDelivery(
  database: DatabaseSync,
  args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  },
): void {
  assertNonEmpty(args.threadId, 'threadId');
  assertCellId(args.cellId);
  database
    .prepare(
      `
        DELETE FROM ptc_execute_code_running_wait_deliveries
        WHERE thread_id = ? AND cell_id = ?
      `,
    )
    .run(args.threadId, args.cellId);
}

export function readPtcExecuteCodeRunningExecDelivery(
  database: DatabaseSync,
  args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  },
): PtcExecuteCodeRunningExecDelivery | undefined {
  assertNonEmpty(args.threadId, 'threadId');
  assertCellId(args.cellId);
  const row: unknown = database
    .prepare(
      `
        SELECT
          thread_id AS threadId,
          cell_id AS cellId,
          run_id AS runId,
          call_id AS callId,
          stdout,
          stderr,
          duration_ms AS durationMs,
          tool_callback_count AS toolCallbackCount,
          stdout_read_offset_bytes AS stdoutReadOffsetBytes,
          stderr_read_offset_bytes AS stderrReadOffsetBytes
        FROM ptc_execute_code_running_exec_deliveries
        WHERE thread_id = ? AND cell_id = ?
      `,
    )
    .get(args.threadId, args.cellId);
  return row === undefined ? undefined : parseRunningExecDeliveryRow(row);
}

export function persistPtcExecuteCodeRunningExecDelivery(
  database: DatabaseSync,
  delivery: PtcExecuteCodeRunningExecDelivery,
): void {
  validateRunningExecDelivery(delivery);
  runImmediateTransaction(database, () => {
    const updated = database
      .prepare(
        `
          UPDATE ptc_execute_code_cell_coordinates
          SET
            stdout_read_offset_bytes = ?,
            stderr_read_offset_bytes = ?
          WHERE cell_id = ? AND thread_id = ?
        `,
      )
      .run(
        delivery.outputReadOffsets.stdoutBytes,
        delivery.outputReadOffsets.stderrBytes,
        delivery.cellId,
        delivery.threadId,
      );
    if (updated.changes !== 1) {
      throw new Error(
        'PTC running exec delivery requires a matching live cell coordinate',
      );
    }
    database
      .prepare(
        `
          INSERT INTO ptc_execute_code_running_exec_deliveries (
            thread_id,
            cell_id,
            run_id,
            call_id,
            stdout,
            stderr,
            duration_ms,
            tool_callback_count,
            stdout_read_offset_bytes,
            stderr_read_offset_bytes
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, cell_id) DO UPDATE SET
            run_id = excluded.run_id,
            call_id = excluded.call_id,
            stdout = excluded.stdout,
            stderr = excluded.stderr,
            duration_ms = excluded.duration_ms,
            tool_callback_count = excluded.tool_callback_count,
            stdout_read_offset_bytes = excluded.stdout_read_offset_bytes,
            stderr_read_offset_bytes = excluded.stderr_read_offset_bytes
        `,
      )
      .run(
        delivery.threadId,
        delivery.cellId,
        delivery.runId,
        delivery.callId,
        delivery.stdout,
        delivery.stderr,
        delivery.durationMs,
        delivery.toolCallbackCount,
        delivery.outputReadOffsets.stdoutBytes,
        delivery.outputReadOffsets.stderrBytes,
      );
  });
}

export function deletePtcExecuteCodeRunningExecDelivery(
  database: DatabaseSync,
  args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  },
): void {
  assertNonEmpty(args.threadId, 'threadId');
  assertCellId(args.cellId);
  database
    .prepare(
      `
        DELETE FROM ptc_execute_code_running_exec_deliveries
        WHERE thread_id = ? AND cell_id = ?
      `,
    )
    .run(args.threadId, args.cellId);
}

function parseCoordinateRow(row: unknown): PtcExecuteCodeCellCoordinate {
  if (
    !isRecord(row) ||
    typeof row['cellId'] !== 'string' ||
    typeof row['stateRoot'] !== 'string' ||
    typeof row['threadId'] !== 'string' ||
    typeof row['createdAtMs'] !== 'number' ||
    typeof row['effectiveTimeoutMs'] !== 'number' ||
    (row['orphanReapAtMs'] !== null &&
      typeof row['orphanReapAtMs'] !== 'number') ||
    typeof row['processOutputRef'] !== 'string' ||
    (row['callbackOutputRef'] !== null &&
      typeof row['callbackOutputRef'] !== 'string') ||
    typeof row['identityJson'] !== 'string' ||
    typeof row['containerId'] !== 'string' ||
    typeof row['maxBufferedBytesPerStream'] !== 'number' ||
    typeof row['callbackToolNamesJson'] !== 'string' ||
    (row['storeCallbacksEnabled'] !== 0 &&
      row['storeCallbacksEnabled'] !== 1) ||
    (row['stdoutReadOffsetBytes'] !== null &&
      typeof row['stdoutReadOffsetBytes'] !== 'number') ||
    (row['stderrReadOffsetBytes'] !== null &&
      typeof row['stderrReadOffsetBytes'] !== 'number') ||
    (row['stdoutReadOffsetBytes'] === null) !==
      (row['stderrReadOffsetBytes'] === null)
  ) {
    throw new Error('persisted PTC cell coordinate row is invalid');
  }
  const identity = parseIdentityJson(row['identityJson']);
  const callbackToolNames = parseCallbackToolNamesJson(
    row['callbackToolNamesJson'],
  );
  const coordinate: PtcExecuteCodeCellCoordinate = {
    cellId: row['cellId'] as PtcExecuteCodeCellId,
    stateRoot: row['stateRoot'],
    threadId: row['threadId'],
    createdAtMs: row['createdAtMs'],
    effectiveTimeoutMs: row['effectiveTimeoutMs'],
    ...(row['orphanReapAtMs'] === null
      ? {}
      : { orphanReapAtMs: row['orphanReapAtMs'] }),
    processOutputRef: row['processOutputRef'],
    ...(row['callbackOutputRef'] === null
      ? {}
      : { callbackOutputRef: row['callbackOutputRef'] }),
    ...identity,
    containerId: row['containerId'],
    maxBufferedBytesPerStream: row['maxBufferedBytesPerStream'],
    callbackToolNames,
    storeCallbacksEnabled: row['storeCallbacksEnabled'] === 1,
    ...(row['stdoutReadOffsetBytes'] === null
      ? {}
      : {
          outputReadOffsets: {
            stdoutBytes: row['stdoutReadOffsetBytes'],
            stderrBytes: row['stderrReadOffsetBytes'] as number,
          },
        }),
  };
  validateCoordinate(coordinate);
  return coordinate;
}

function parseRunningWaitDeliveryRow(
  row: unknown,
): PtcExecuteCodeRunningWaitDelivery {
  if (
    !isRecord(row) ||
    typeof row['threadId'] !== 'string' ||
    typeof row['cellId'] !== 'string' ||
    typeof row['runId'] !== 'string' ||
    typeof row['callId'] !== 'string' ||
    typeof row['stdout'] !== 'string' ||
    typeof row['stderr'] !== 'string' ||
    typeof row['stdoutReadOffsetBytes'] !== 'number' ||
    typeof row['stderrReadOffsetBytes'] !== 'number'
  ) {
    throw new Error('persisted PTC running wait delivery row is invalid');
  }
  const delivery: PtcExecuteCodeRunningWaitDelivery = {
    threadId: row['threadId'],
    cellId: row['cellId'] as PtcExecuteCodeCellId,
    runId: row['runId'],
    callId: row['callId'],
    stdout: row['stdout'],
    stderr: row['stderr'],
    outputReadOffsets: {
      stdoutBytes: row['stdoutReadOffsetBytes'],
      stderrBytes: row['stderrReadOffsetBytes'],
    },
  };
  validateRunningWaitDelivery(delivery);
  return delivery;
}

function parseRunningExecDeliveryRow(
  row: unknown,
): PtcExecuteCodeRunningExecDelivery {
  if (
    !isRecord(row) ||
    typeof row['threadId'] !== 'string' ||
    typeof row['cellId'] !== 'string' ||
    typeof row['runId'] !== 'string' ||
    typeof row['callId'] !== 'string' ||
    typeof row['stdout'] !== 'string' ||
    typeof row['stderr'] !== 'string' ||
    typeof row['durationMs'] !== 'number' ||
    typeof row['toolCallbackCount'] !== 'number' ||
    typeof row['stdoutReadOffsetBytes'] !== 'number' ||
    typeof row['stderrReadOffsetBytes'] !== 'number'
  ) {
    throw new Error('persisted PTC running exec delivery row is invalid');
  }
  const delivery: PtcExecuteCodeRunningExecDelivery = {
    threadId: row['threadId'],
    cellId: row['cellId'] as PtcExecuteCodeCellId,
    runId: row['runId'],
    callId: row['callId'],
    stdout: row['stdout'],
    stderr: row['stderr'],
    durationMs: row['durationMs'],
    toolCallbackCount: row['toolCallbackCount'],
    outputReadOffsets: {
      stdoutBytes: row['stdoutReadOffsetBytes'],
      stderrBytes: row['stderrReadOffsetBytes'],
    },
  };
  validateRunningExecDelivery(delivery);
  return delivery;
}

function parseIdentityJson(
  serialized: string,
): Pick<
  PtcExecuteCodeCellCoordinate,
  'trustContextId' | 'ephemeralBurstId' | 'sdkProjectionMount'
> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('persisted PTC cell identity JSON is invalid');
  }
  if (
    !isRecord(value) ||
    typeof value['trustContextId'] !== 'string' ||
    (value['ephemeralBurstId'] !== undefined &&
      (typeof value['ephemeralBurstId'] !== 'string' ||
        !value['ephemeralBurstId'].startsWith('ptc_burst_')))
  ) {
    throw new Error('persisted PTC cell identity is invalid');
  }
  const sdkProjectionMount =
    value['sdkProjectionMount'] === undefined
      ? undefined
      : parseSdkProjectionMount(value['sdkProjectionMount']);
  return {
    trustContextId: value['trustContextId'],
    ...(value['ephemeralBurstId'] === undefined
      ? {}
      : {
          ephemeralBurstId: value['ephemeralBurstId'] as `ptc_burst_${string}`,
        }),
    ...(sdkProjectionMount === undefined ? {} : { sdkProjectionMount }),
  };
}

function parseSdkProjectionMount(
  value: unknown,
): PtcSessionDockerSdkProjectionMount {
  if (
    !isRecord(value) ||
    typeof value['hostRootPath'] !== 'string' ||
    value['containerRootPath'] !== PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT ||
    value['mountPolicyId'] !==
      PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID ||
    typeof value['sdkVersion'] !== 'string' ||
    typeof value['sdkProjectionHash'] !== 'string' ||
    !value['sdkProjectionHash'].startsWith('sha256:') ||
    typeof value['policyId'] !== 'string' ||
    typeof value['importSpecifier'] !== 'string'
  ) {
    throw new Error('persisted PTC cell SDK projection mount is invalid');
  }
  return {
    hostRootPath: value['hostRootPath'],
    containerRootPath: value['containerRootPath'],
    mountPolicyId: value['mountPolicyId'],
    sdkVersion: value['sdkVersion'],
    sdkProjectionHash: value['sdkProjectionHash'] as `sha256:${string}`,
    policyId: value['policyId'],
    importSpecifier: value['importSpecifier'],
  };
}

function parseCallbackToolNamesJson(serialized: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('persisted PTC cell callback tool names JSON is invalid');
  }
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error('persisted PTC cell callback tool names are invalid');
  }
  return value;
}

function validateCoordinate(coordinate: PtcExecuteCodeCellCoordinate): void {
  assertCellId(coordinate.cellId);
  assertNonEmpty(coordinate.threadId, 'threadId');
  assertNonEmpty(coordinate.processOutputRef, 'processOutputRef');
  assertNonEmpty(coordinate.containerId, 'containerId');
  if (!isAbsolute(coordinate.stateRoot)) {
    throw new Error('PTC cell coordinate stateRoot must be absolute');
  }
  assertNonEmpty(coordinate.trustContextId, 'trustContextId');
  if (
    coordinate.ephemeralBurstId !== undefined &&
    !coordinate.ephemeralBurstId.startsWith('ptc_burst_')
  ) {
    throw new Error('PTC cell coordinate ephemeralBurstId is invalid');
  }
  if (coordinate.sdkProjectionMount !== undefined) {
    parseSdkProjectionMount(coordinate.sdkProjectionMount);
  }
  assertSafeInteger(coordinate.createdAtMs, 'createdAtMs', 0);
  assertSafeInteger(coordinate.effectiveTimeoutMs, 'effectiveTimeoutMs', 1);
  if (coordinate.orphanReapAtMs !== undefined) {
    assertSafeInteger(coordinate.orphanReapAtMs, 'orphanReapAtMs', 0);
  }
  if (coordinate.outputReadOffsets !== undefined) {
    assertSafeInteger(
      coordinate.outputReadOffsets.stdoutBytes,
      'stdoutReadOffsetBytes',
      0,
    );
    assertSafeInteger(
      coordinate.outputReadOffsets.stderrBytes,
      'stderrReadOffsetBytes',
      0,
    );
  }
  assertSafeInteger(
    coordinate.maxBufferedBytesPerStream,
    'maxBufferedBytesPerStream',
    1,
  );
  if (coordinate.callbackOutputRef !== undefined) {
    assertNonEmpty(coordinate.callbackOutputRef, 'callbackOutputRef');
  } else if (
    coordinate.callbackToolNames.length > 0 ||
    coordinate.storeCallbacksEnabled
  ) {
    throw new Error(
      'PTC cell coordinate callback authority requires a callback session',
    );
  }
  const uniqueToolNames = new Set<string>();
  for (const toolName of coordinate.callbackToolNames) {
    assertNonEmpty(toolName, 'callbackToolName');
    if (uniqueToolNames.has(toolName)) {
      throw new Error('PTC cell coordinate callback tool names must be unique');
    }
    uniqueToolNames.add(toolName);
  }
}

function validateRunningWaitDelivery(
  delivery: PtcExecuteCodeRunningWaitDelivery,
): void {
  assertNonEmpty(delivery.threadId, 'threadId');
  assertCellId(delivery.cellId);
  assertNonEmpty(delivery.runId, 'runId');
  assertNonEmpty(delivery.callId, 'callId');
  assertSafeInteger(
    delivery.outputReadOffsets.stdoutBytes,
    'stdoutReadOffsetBytes',
    0,
  );
  assertSafeInteger(
    delivery.outputReadOffsets.stderrBytes,
    'stderrReadOffsetBytes',
    0,
  );
}

function validateRunningExecDelivery(
  delivery: PtcExecuteCodeRunningExecDelivery,
): void {
  assertNonEmpty(delivery.threadId, 'threadId');
  assertCellId(delivery.cellId);
  assertNonEmpty(delivery.runId, 'runId');
  assertNonEmpty(delivery.callId, 'callId');
  assertSafeInteger(delivery.durationMs, 'durationMs', 0);
  assertSafeInteger(delivery.toolCallbackCount, 'toolCallbackCount', 0);
  assertSafeInteger(
    delivery.outputReadOffsets.stdoutBytes,
    'stdoutReadOffsetBytes',
    0,
  );
  assertSafeInteger(
    delivery.outputReadOffsets.stderrBytes,
    'stderrReadOffsetBytes',
    0,
  );
}

function assertCellId(cellId: string): asserts cellId is PtcExecuteCodeCellId {
  if (!cellId.startsWith('ptc_cell_') || cellId.length === 'ptc_cell_'.length) {
    throw new Error('PTC cell coordinate cellId is invalid');
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`PTC cell coordinate ${field} must not be empty`);
  }
}

function assertSafeInteger(
  value: number,
  field: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`PTC cell coordinate ${field} is invalid`);
  }
}
