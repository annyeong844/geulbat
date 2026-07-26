import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertRunId,
  assertThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import { isPermissionMode } from '@geulbat/protocol/run-approval';
import {
  isRunProviderId,
  isRunReasoningEffort,
  isRunServiceTier,
  isRunSubagentModelRouting,
  isSubagentModelSelectionSource,
} from '@geulbat/protocol/run-contract';
import {
  isProviderRequestDiagnostics,
  isSubagentCapabilities,
  isSubagentRuntimeDiagnostics,
  isSubagentType,
} from '@geulbat/protocol/run-events';

import { isRecord } from './runtime-json.js';
import {
  isSubagentLaunchDeferReason,
  isSubagentLaunchPriorityClass,
  isSubagentLaunchRequestState,
  type DurableSubagentLaunchRequest,
  type DurableSubagentLaunchRetry,
  type SubagentLaunchDeferReason,
  type SubagentLaunchPriorityClass,
  type SubagentLaunchRequestInput,
  type SubagentLaunchRequestState,
  type SubagentLaunchRequestStore,
  type SubagentRuntimeDiagnostics,
} from './subagent-runtime-contracts.js';
import { runImmediateTransaction } from './runtime-state-database.js';

export function parsePersistedSubagentLaunchInput(
  inputJson: string,
): SubagentLaunchRequestInput {
  const input: unknown = JSON.parse(inputJson);
  if (
    !isRecord(input) ||
    typeof input['toolCallId'] !== 'string' ||
    input['toolCallId'].trim() === '' ||
    typeof input['task'] !== 'string' ||
    input['task'].trim() === '' ||
    !isSubagentType(input['subagentType']) ||
    !isSubagentCapabilities(input['capabilities']) ||
    typeof input['parentRunId'] !== 'string' ||
    typeof input['ownerThreadId'] !== 'string' ||
    typeof input['stateRoot'] !== 'string' ||
    !isAbsolute(input['stateRoot']) ||
    typeof input['workingDirectory'] !== 'string' ||
    (input['permissionMode'] !== undefined &&
      !isPermissionMode(input['permissionMode'])) ||
    (input['ultraReasoning'] !== undefined &&
      typeof input['ultraReasoning'] !== 'boolean') ||
    !isRecord(input['modelPin']) ||
    typeof input['modelPin']['modelId'] !== 'string' ||
    input['modelPin']['modelId'].trim() === '' ||
    !isSubagentModelSelectionSource(input['modelPin']['selectionSource']) ||
    !isRecord(input['modelPin']['providerRunSelection']) ||
    !isRecord(input['modelPin']['providerRunSelection']['providerModel']) ||
    !isRunProviderId(
      input['modelPin']['providerRunSelection']['providerModel']['providerId'],
    ) ||
    typeof input['modelPin']['providerRunSelection']['providerModel'][
      'model'
    ] !== 'string' ||
    input['modelPin']['providerRunSelection']['providerModel'][
      'model'
    ].trim() === '' ||
    !isRunReasoningEffort(
      input['modelPin']['providerRunSelection']['reasoningEffort'],
    ) ||
    (input['modelPin']['providerRunSelection']['serviceTier'] !== undefined &&
      !isRunServiceTier(
        input['modelPin']['providerRunSelection']['serviceTier'],
      )) ||
    !isRunSubagentModelRouting(input['subagentModelRouting'])
  ) {
    throw new Error('persisted subagent launch input is invalid');
  }
  return {
    toolCallId: input['toolCallId'],
    task: input['task'],
    subagentType: input['subagentType'],
    capabilities: [...input['capabilities']],
    parentRunId: assertRunId(input['parentRunId']),
    ownerThreadId: assertThreadId(input['ownerThreadId']),
    stateRoot: input['stateRoot'],
    workingDirectory: input['workingDirectory'],
    ...(input['permissionMode'] === undefined
      ? {}
      : { permissionMode: input['permissionMode'] }),
    ultraReasoning: input['ultraReasoning'] ?? false,
    modelPin: {
      modelId: input['modelPin']['modelId'],
      providerRunSelection: {
        providerModel: {
          providerId:
            input['modelPin']['providerRunSelection']['providerModel'][
              'providerId'
            ],
          model:
            input['modelPin']['providerRunSelection']['providerModel']['model'],
        },
        reasoningEffort:
          input['modelPin']['providerRunSelection']['reasoningEffort'],
        ...(input['modelPin']['providerRunSelection']['serviceTier'] ===
        undefined
          ? {}
          : {
              serviceTier:
                input['modelPin']['providerRunSelection']['serviceTier'],
            }),
      },
      selectionSource: input['modelPin']['selectionSource'],
    },
    subagentModelRouting: input['subagentModelRouting'],
  };
}

export function enqueueSubagentLaunchBatch(
  database: DatabaseSync,
  requests: readonly SubagentLaunchRequestInput[],
  now: () => Date,
): readonly DurableSubagentLaunchRequest[] {
  if (requests.length === 0) {
    throw new Error('subagent launch batch must contain at least one request');
  }
  const requestKeys = new Set<string>();
  for (const request of requests) {
    if (request.toolCallId.trim() === '') {
      throw new Error('subagent launch toolCallId must not be empty');
    }
    const requestKey = `${request.parentRunId}\u0000${request.toolCallId}`;
    if (requestKeys.has(requestKey)) {
      throw new Error(
        `subagent launch batch repeats tool call ${request.toolCallId}`,
      );
    }
    requestKeys.add(requestKey);
  }

  const batchId = requests.length > 1 ? randomUUID() : null;
  const timestamp = now().toISOString();
  const accepted: Array<{
    parentRunId: RunId;
    toolCallId: string;
  }> = [];
  const insert = database.prepare(`
    INSERT INTO subagent_launch_requests (
      child_run_id,
      child_thread_id,
      previous_child_run_id,
      parent_run_id,
      owner_thread_id,
      tool_call_id,
      batch_id,
      batch_position,
      launch_state,
      priority_class,
      input_json,
      defer_reason,
      failure_reason,
      runtime_phase,
      last_activity_at,
      last_tool_name,
      last_tool_call_id,
      last_tool_state,
      partial_output_available,
      created_at,
      updated_at
    ) VALUES (
      ?, ?, NULL, ?, ?, ?, ?, ?, 'queued', 'normal', ?, NULL, NULL,
      'queued', ?, NULL, NULL, NULL, 0, ?, ?
    )
  `);

  runImmediateTransaction(database, () => {
    for (const [batchPosition, request] of requests.entries()) {
      insert.run(
        randomUUID(),
        randomUUID(),
        request.parentRunId,
        request.ownerThreadId,
        request.toolCallId,
        batchId,
        batchPosition,
        JSON.stringify(request),
        timestamp,
        timestamp,
        timestamp,
      );
      accepted.push({
        parentRunId: request.parentRunId,
        toolCallId: request.toolCallId,
      });
    }
  });

  return accepted.map((requestKey) => {
    const request = readSubagentLaunchRequest(database, requestKey);
    if (request === undefined) {
      throw new Error(
        `accepted subagent launch request disappeared: ${requestKey.toolCallId}`,
      );
    }
    return request;
  });
}

export function readSubagentLaunchRequest(
  database: DatabaseSync,
  args: { parentRunId: RunId; toolCallId: string },
): DurableSubagentLaunchRequest | undefined {
  const row = database
    .prepare(
      `
        SELECT
          enqueue_order AS enqueueOrder,
          child_run_id AS childRunId,
          child_thread_id AS childThreadId,
          previous_child_run_id AS previousChildRunId,
          parent_run_id AS parentRunId,
          owner_thread_id AS ownerThreadId,
          tool_call_id AS toolCallId,
          batch_id AS batchId,
          batch_position AS batchPosition,
          launch_state AS launchState,
          priority_class AS priorityClass,
          defer_reason AS deferReason,
          failure_reason AS failureReason,
          runtime_phase AS runtimePhase,
          last_activity_at AS lastActivityAt,
          last_tool_name AS lastToolName,
          last_tool_call_id AS lastToolCallId,
          last_tool_state AS lastToolState,
          partial_output_available AS partialOutputAvailable,
          provider_request_json AS providerRequestJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM subagent_launch_requests
        WHERE parent_run_id = ? AND tool_call_id = ?
      `,
    )
    .get(args.parentRunId, args.toolCallId);
  return row === undefined ? undefined : parseSubagentLaunchRequestRow(row);
}

export function readQueuedSubagentLaunchRequests(
  database: DatabaseSync,
): readonly DurableSubagentLaunchRequest[] {
  const rows = database
    .prepare(
      `
        SELECT
          enqueue_order AS enqueueOrder,
          child_run_id AS childRunId,
          child_thread_id AS childThreadId,
          previous_child_run_id AS previousChildRunId,
          parent_run_id AS parentRunId,
          owner_thread_id AS ownerThreadId,
          tool_call_id AS toolCallId,
          batch_id AS batchId,
          batch_position AS batchPosition,
          launch_state AS launchState,
          priority_class AS priorityClass,
          defer_reason AS deferReason,
          failure_reason AS failureReason,
          runtime_phase AS runtimePhase,
          last_activity_at AS lastActivityAt,
          last_tool_name AS lastToolName,
          last_tool_call_id AS lastToolCallId,
          last_tool_state AS lastToolState,
          partial_output_available AS partialOutputAvailable,
          provider_request_json AS providerRequestJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM subagent_launch_requests
        WHERE launch_state = 'queued'
        ORDER BY
          CASE priority_class
            WHEN 'high' THEN 0
            WHEN 'normal' THEN 1
            WHEN 'low' THEN 2
          END,
          enqueue_order
      `,
    )
    .all();
  return rows.map(parseSubagentLaunchRequestRow);
}

export function retryInterruptedSubagentLaunch(
  database: DatabaseSync,
  args: Parameters<
    SubagentLaunchRequestStore['retryInterruptedSubagentLaunch']
  >[0],
  now: () => Date,
): DurableSubagentLaunchRetry {
  let retry: DurableSubagentLaunchRetry | undefined;
  runImmediateTransaction(database, () => {
    const sameCall = readSubagentLaunchRequest(database, {
      parentRunId: args.parentRunId,
      toolCallId: args.toolCallId,
    });
    if (sameCall !== undefined) {
      if (sameCall.previousChildRunId !== args.previousChildRunId) {
        throw new Error(
          `subagent retry tool call conflicts with child run ${sameCall.childRunId}`,
        );
      }
      retry = {
        disposition: 'same_call_replay',
        request: sameCall,
        input: readPersistedSubagentLaunchInput(database, sameCall.childRunId),
      };
      return;
    }

    const previous = readSubagentLaunchRequestByChildRunId(
      database,
      args.previousChildRunId,
    );
    if (previous === undefined) {
      throw new Error(
        `interrupted subagent launch does not exist: ${args.previousChildRunId}`,
      );
    }
    if (previous.ownerThreadId !== args.ownerThreadId) {
      throw new Error(
        `interrupted subagent launch belongs to another owner thread: ${args.previousChildRunId}`,
      );
    }
    if (previous.launchState !== 'interrupted') {
      throw new Error(
        `subagent launch cannot be retried from ${previous.launchState}: ${args.previousChildRunId}`,
      );
    }

    const existingRetry = readSubagentLaunchRetryByPreviousChildRunId(
      database,
      args.previousChildRunId,
    );
    if (existingRetry !== undefined) {
      retry = {
        disposition: 'already_retried',
        request: existingRetry,
        input: readPersistedSubagentLaunchInput(
          database,
          existingRetry.childRunId,
        ),
      };
      return;
    }

    const previousInput = readPersistedSubagentLaunchInput(
      database,
      previous.childRunId,
    );
    if (
      previousInput.parentRunId !== previous.parentRunId ||
      previousInput.ownerThreadId !== previous.ownerThreadId ||
      previousInput.toolCallId !== previous.toolCallId
    ) {
      throw new Error(
        `interrupted subagent launch input identity is invalid: ${args.previousChildRunId}`,
      );
    }

    const input: SubagentLaunchRequestInput = {
      toolCallId: args.toolCallId,
      task: previousInput.task,
      subagentType: previousInput.subagentType,
      capabilities: previousInput.capabilities,
      parentRunId: args.parentRunId,
      ownerThreadId: args.ownerThreadId,
      stateRoot: args.stateRoot,
      workingDirectory: args.workingDirectory,
      ...(args.permissionMode === undefined
        ? {}
        : { permissionMode: args.permissionMode }),
      ultraReasoning: previousInput.ultraReasoning ?? false,
      modelPin: previousInput.modelPin,
      subagentModelRouting: previousInput.subagentModelRouting,
    };
    const timestamp = now().toISOString();
    const childRunId = assertRunId(randomUUID());
    database
      .prepare(
        `
          INSERT INTO subagent_launch_requests (
            child_run_id,
            child_thread_id,
            previous_child_run_id,
            parent_run_id,
            owner_thread_id,
            tool_call_id,
            batch_id,
            batch_position,
            launch_state,
            priority_class,
            input_json,
            defer_reason,
            failure_reason,
            runtime_phase,
            last_activity_at,
            last_tool_name,
            last_tool_call_id,
            last_tool_state,
            partial_output_available,
            created_at,
            updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, NULL, 0, 'queued', 'normal', ?, NULL, NULL,
            'queued', ?, NULL, NULL, NULL, 0, ?, ?
          )
        `,
      )
      .run(
        childRunId,
        randomUUID(),
        previous.childRunId,
        input.parentRunId,
        input.ownerThreadId,
        input.toolCallId,
        JSON.stringify(input),
        timestamp,
        timestamp,
        timestamp,
      );
    const request = readSubagentLaunchRequestByChildRunId(database, childRunId);
    if (request === undefined) {
      throw new Error(
        `accepted subagent retry disappeared: ${args.previousChildRunId}`,
      );
    }
    retry = { disposition: 'created', request, input };
  });
  if (retry === undefined) {
    throw new Error(
      `subagent retry transaction returned no result: ${args.previousChildRunId}`,
    );
  }
  return retry;
}

function readSubagentLaunchRetryByPreviousChildRunId(
  database: DatabaseSync,
  previousChildRunId: RunId,
): DurableSubagentLaunchRequest | undefined {
  const row = database
    .prepare(
      `
        SELECT child_run_id AS childRunId
        FROM subagent_launch_requests
        WHERE previous_child_run_id = ?
      `,
    )
    .get(previousChildRunId);
  if (row === undefined) {
    return undefined;
  }
  if (!isRecord(row) || typeof row['childRunId'] !== 'string') {
    throw new Error('subagent retry lineage row is invalid');
  }
  return readSubagentLaunchRequestByChildRunId(
    database,
    assertRunId(row['childRunId']),
  );
}

function readPersistedSubagentLaunchInput(
  database: DatabaseSync,
  childRunId: RunId,
): SubagentLaunchRequestInput {
  const row = database
    .prepare(
      `
        SELECT input_json AS inputJson
        FROM subagent_launch_requests
        WHERE child_run_id = ?
      `,
    )
    .get(childRunId);
  if (!isRecord(row) || typeof row['inputJson'] !== 'string') {
    throw new Error(`subagent launch input does not exist: ${childRunId}`);
  }
  return parsePersistedSubagentLaunchInput(row['inputJson']);
}

export function markSubagentLaunchDeferredBatch(
  database: DatabaseSync,
  args: {
    childRunIds: readonly RunId[];
    deferReason: SubagentLaunchDeferReason;
  },
  now: () => Date,
): readonly DurableSubagentLaunchRequest[] {
  if (args.childRunIds.length === 0) {
    throw new Error('deferred subagent launch batch must not be empty');
  }
  if (!isSubagentLaunchDeferReason(args.deferReason)) {
    throw new Error(
      `invalid subagent launch defer reason: ${String(args.deferReason)}`,
    );
  }
  if (new Set(args.childRunIds).size !== args.childRunIds.length) {
    throw new Error('deferred subagent launch batch repeats a child run id');
  }

  return runImmediateTransaction(database, () => {
    for (const childRunId of args.childRunIds) {
      const current = readSubagentLaunchRequestByChildRunId(
        database,
        childRunId,
      );
      if (current === undefined) {
        throw new Error(
          `subagent launch request does not exist: ${childRunId}`,
        );
      }
      if (current.launchState !== 'queued') {
        throw new Error(
          `subagent launch request cannot defer from ${current.launchState}: ${childRunId}`,
        );
      }
    }

    const update = database.prepare(`
      UPDATE subagent_launch_requests
      SET defer_reason = ?, updated_at = ?
      WHERE child_run_id = ? AND launch_state = 'queued'
    `);
    const timestamp = now().toISOString();
    for (const childRunId of args.childRunIds) {
      const result = update.run(args.deferReason, timestamp, childRunId);
      if (Number(result.changes) !== 1) {
        throw new Error(
          `subagent launch request defer lost its queued state: ${childRunId}`,
        );
      }
    }
    return args.childRunIds.map((childRunId) => {
      const request = readSubagentLaunchRequestByChildRunId(
        database,
        childRunId,
      );
      if (request === undefined) {
        throw new Error(`deferred subagent launch disappeared: ${childRunId}`);
      }
      return request;
    });
  });
}

export function cancelQueuedSubagentLaunchRequest(
  database: DatabaseSync,
  args: { childRunId: RunId; ownerThreadId: ThreadId },
  now: () => Date,
): DurableSubagentLaunchRequest {
  return runImmediateTransaction(database, () => {
    const current = readOwnedSubagentLaunchRequest(database, args);
    if (current.launchState !== 'queued') {
      return current;
    }
    database
      .prepare(
        `
          UPDATE subagent_launch_requests
          SET launch_state = 'cancelled', defer_reason = NULL, updated_at = ?
          WHERE child_run_id = ?
            AND owner_thread_id = ?
            AND launch_state = 'queued'
        `,
      )
      .run(now().toISOString(), args.childRunId, args.ownerThreadId);
    return readOwnedSubagentLaunchRequest(database, args);
  });
}

export function updateQueuedSubagentLaunchPriority(
  database: DatabaseSync,
  args: {
    childRunId: RunId;
    ownerThreadId: ThreadId;
    priorityClass: SubagentLaunchPriorityClass;
  },
  now: () => Date,
): DurableSubagentLaunchRequest {
  if (!isSubagentLaunchPriorityClass(args.priorityClass)) {
    throw new Error(
      `invalid subagent launch priority: ${String(args.priorityClass)}`,
    );
  }
  return runImmediateTransaction(database, () => {
    const current = readOwnedSubagentLaunchRequest(database, args);
    if (
      current.launchState !== 'queued' ||
      current.priorityClass === args.priorityClass
    ) {
      return current;
    }
    database
      .prepare(
        `
          UPDATE subagent_launch_requests
          SET priority_class = ?, updated_at = ?
          WHERE child_run_id = ?
            AND owner_thread_id = ?
            AND launch_state = 'queued'
        `,
      )
      .run(
        args.priorityClass,
        now().toISOString(),
        args.childRunId,
        args.ownerThreadId,
      );
    return readOwnedSubagentLaunchRequest(database, args);
  });
}

function readOwnedSubagentLaunchRequest(
  database: DatabaseSync,
  args: { childRunId: RunId; ownerThreadId: ThreadId },
): DurableSubagentLaunchRequest {
  const current = readSubagentLaunchRequestByChildRunId(
    database,
    args.childRunId,
  );
  if (current === undefined) {
    throw new Error(
      `subagent launch request does not exist: ${args.childRunId}`,
    );
  }
  if (current.ownerThreadId !== args.ownerThreadId) {
    throw new Error(
      `subagent launch request does not belong to owner thread: ${args.childRunId}`,
    );
  }
  return current;
}

export function transitionSubagentLaunchRequest(
  database: DatabaseSync,
  args: {
    childRunId: RunId;
    fromStates: readonly SubagentLaunchRequestState[];
    toState: SubagentLaunchRequestState;
    failureReason: string | null;
    runtimePhase?: SubagentRuntimeDiagnostics['phase'];
    now: () => Date;
  },
): void {
  runImmediateTransaction(database, () => {
    const placeholders = args.fromStates.map(() => '?').join(', ');
    const timestamp = args.now().toISOString();
    const runtimePhase = args.runtimePhase ?? null;
    const result = database
      .prepare(
        `
          UPDATE subagent_launch_requests
          SET
            launch_state = ?,
            defer_reason = NULL,
            failure_reason = ?,
            runtime_phase = COALESCE(?, runtime_phase),
            last_activity_at = CASE
              WHEN ? IS NULL THEN last_activity_at
              ELSE ?
            END,
            updated_at = ?
          WHERE child_run_id = ? AND launch_state IN (${placeholders})
        `,
      )
      .run(
        args.toState,
        args.failureReason,
        runtimePhase,
        runtimePhase,
        timestamp,
        timestamp,
        args.childRunId,
        ...args.fromStates,
      );
    if (Number(result.changes) === 1) {
      return;
    }
    const current = readSubagentLaunchRequestByChildRunId(
      database,
      args.childRunId,
    );
    if (current?.launchState === args.toState) {
      return;
    }
    if (current === undefined) {
      throw new Error(
        `subagent launch request does not exist: ${args.childRunId}`,
      );
    }
    throw new Error(
      `subagent launch request cannot transition from ${current.launchState} to ${args.toState}`,
    );
  });
}

export function readSubagentLaunchRequestByChildRunId(
  database: DatabaseSync,
  childRunId: RunId,
): DurableSubagentLaunchRequest | undefined {
  const row = database
    .prepare(
      `
        SELECT
          enqueue_order AS enqueueOrder,
          child_run_id AS childRunId,
          child_thread_id AS childThreadId,
          previous_child_run_id AS previousChildRunId,
          parent_run_id AS parentRunId,
          owner_thread_id AS ownerThreadId,
          tool_call_id AS toolCallId,
          batch_id AS batchId,
          batch_position AS batchPosition,
          launch_state AS launchState,
          priority_class AS priorityClass,
          defer_reason AS deferReason,
          failure_reason AS failureReason,
          runtime_phase AS runtimePhase,
          last_activity_at AS lastActivityAt,
          last_tool_name AS lastToolName,
          last_tool_call_id AS lastToolCallId,
          last_tool_state AS lastToolState,
          partial_output_available AS partialOutputAvailable,
          provider_request_json AS providerRequestJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM subagent_launch_requests
        WHERE child_run_id = ?
      `,
    )
    .get(childRunId);
  return row === undefined ? undefined : parseSubagentLaunchRequestRow(row);
}

export function recordSubagentRuntimeObservation(
  database: DatabaseSync,
  args: {
    childRunId: RunId;
    runtime: SubagentRuntimeDiagnostics;
  },
): void {
  if (!isSubagentRuntimeDiagnostics(args.runtime)) {
    throw new Error('subagent runtime observation is invalid');
  }
  runImmediateTransaction(database, () => {
    const current = readSubagentLaunchRequestByChildRunId(
      database,
      args.childRunId,
    );
    if (current === undefined) {
      throw new Error(
        `subagent launch request does not exist: ${args.childRunId}`,
      );
    }
    if (
      (args.runtime.previousChildRunId ?? null) !== current.previousChildRunId
    ) {
      throw new Error(
        `subagent runtime retry lineage conflicts with launch request: ${args.childRunId}`,
      );
    }
    const result = database
      .prepare(
        `
          UPDATE subagent_launch_requests
          SET
            runtime_phase = ?,
            last_activity_at = ?,
            last_tool_name = ?,
            last_tool_call_id = ?,
            last_tool_state = ?,
            partial_output_available = ?,
            provider_request_json = ?
          WHERE child_run_id = ?
            AND launch_state IN ('starting', 'started')
        `,
      )
      .run(
        args.runtime.phase,
        args.runtime.observedAt,
        args.runtime.lastTool?.name ?? null,
        args.runtime.lastTool?.callId ?? null,
        args.runtime.lastTool?.state ?? null,
        args.runtime.partialOutputAvailable ? 1 : 0,
        args.runtime.providerRequest === undefined
          ? null
          : JSON.stringify(args.runtime.providerRequest),
        args.childRunId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(
        `subagent runtime observation requires an active launch: ${args.childRunId}`,
      );
    }
  });
}

function parseSubagentLaunchRequestRow(
  row: unknown,
): DurableSubagentLaunchRequest {
  if (
    !isRecord(row) ||
    typeof row['enqueueOrder'] !== 'number' ||
    !Number.isSafeInteger(row['enqueueOrder']) ||
    typeof row['childRunId'] !== 'string' ||
    typeof row['childThreadId'] !== 'string' ||
    (row['previousChildRunId'] !== null &&
      typeof row['previousChildRunId'] !== 'string') ||
    typeof row['parentRunId'] !== 'string' ||
    typeof row['ownerThreadId'] !== 'string' ||
    typeof row['toolCallId'] !== 'string' ||
    (row['batchId'] !== null && typeof row['batchId'] !== 'string') ||
    typeof row['batchPosition'] !== 'number' ||
    !Number.isSafeInteger(row['batchPosition']) ||
    !isSubagentLaunchRequestState(row['launchState']) ||
    !isSubagentLaunchPriorityClass(row['priorityClass']) ||
    (row['deferReason'] !== null &&
      !isSubagentLaunchDeferReason(row['deferReason'])) ||
    (row['failureReason'] !== null &&
      typeof row['failureReason'] !== 'string') ||
    typeof row['runtimePhase'] !== 'string' ||
    typeof row['lastActivityAt'] !== 'string' ||
    (row['lastToolName'] !== null && typeof row['lastToolName'] !== 'string') ||
    (row['lastToolCallId'] !== null &&
      typeof row['lastToolCallId'] !== 'string') ||
    (row['lastToolState'] !== null &&
      typeof row['lastToolState'] !== 'string') ||
    (row['partialOutputAvailable'] !== 0 &&
      row['partialOutputAvailable'] !== 1) ||
    (row['providerRequestJson'] !== null &&
      typeof row['providerRequestJson'] !== 'string') ||
    typeof row['createdAt'] !== 'string' ||
    typeof row['updatedAt'] !== 'string'
  ) {
    throw new Error('subagent launch request row is invalid');
  }
  const previousChildRunId =
    row['previousChildRunId'] === null
      ? null
      : assertRunId(row['previousChildRunId']);
  const providerRequest: unknown =
    row['providerRequestJson'] === null
      ? undefined
      : JSON.parse(row['providerRequestJson']);
  if (
    providerRequest !== undefined &&
    !isProviderRequestDiagnostics(providerRequest)
  ) {
    throw new Error('subagent provider request diagnostics are invalid');
  }
  const runtime = {
    phase: row['runtimePhase'],
    observedAt: row['lastActivityAt'],
    ...(row['lastToolName'] === null ||
    row['lastToolCallId'] === null ||
    row['lastToolState'] === null
      ? {}
      : {
          lastTool: {
            name: row['lastToolName'],
            callId: row['lastToolCallId'],
            state: row['lastToolState'],
          },
        }),
    partialOutputAvailable: row['partialOutputAvailable'] === 1,
    ...(previousChildRunId === null ? {} : { previousChildRunId }),
    ...(providerRequest === undefined ? {} : { providerRequest }),
  };
  if (!isSubagentRuntimeDiagnostics(runtime)) {
    throw new Error('subagent launch runtime diagnostics are invalid');
  }
  return {
    enqueueOrder: row['enqueueOrder'],
    childRunId: assertRunId(row['childRunId']),
    childThreadId: assertThreadId(row['childThreadId']),
    previousChildRunId,
    parentRunId: assertRunId(row['parentRunId']),
    ownerThreadId: assertThreadId(row['ownerThreadId']),
    toolCallId: row['toolCallId'],
    batchId: row['batchId'],
    batchPosition: row['batchPosition'],
    launchState: row['launchState'],
    priorityClass: row['priorityClass'],
    deferReason: row['deferReason'],
    failureReason: row['failureReason'],
    runtime,
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  };
}
