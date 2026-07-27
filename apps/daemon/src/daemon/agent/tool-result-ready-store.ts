import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  deleteToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import type { FunctionCall } from '../llm/index.js';
import { isRecord, tryParseJson } from '../runtime-json.js';
import { parseExecuteResult } from '../tools/result.js';
import type { ExecuteResult } from '../tools/types.js';
import type { ToolCallSource } from './tool-call-source.js';

const TOOL_RESULT_READY_SCHEMA_VERSION = 1;
const TOOL_RESULT_READY_RUN_ID_PREFIX = 'tool-result-ready:';

export type DurableToolResultHistoryMode = 'model_visible' | 'audit_only';

export interface DurableToolResultReady {
  functionCall: FunctionCall;
  round: number;
  toolResult: ExecuteResult;
  computerFilesMayHaveChanged: boolean;
  source?: ToolCallSource;
  historyMode?: DurableToolResultHistoryMode;
}

type ToolResultReadyReadResult =
  | { ok: true; value: DurableToolResultReady }
  | { ok: false; message: string };

export async function persistToolResultReady(args: {
  stateRoot: string;
  threadId: string;
  runId: string;
  ready: DurableToolResultReady;
}): Promise<string> {
  const storageRunId = buildToolResultReadyStorageRunId(args.runId);
  const resultRef = buildToolOutputRef({
    threadId: args.threadId,
    runId: storageRunId,
    callId: args.ready.functionCall.callId,
  });
  const output = JSON.stringify({
    schemaVersion: TOOL_RESULT_READY_SCHEMA_VERSION,
    threadId: args.threadId,
    runId: args.runId,
    ...args.ready,
  });
  await writeToolOutputSnapshot({
    stateRoot: args.stateRoot,
    snapshot: buildToolOutputSnapshot({
      outputRef: resultRef,
      threadId: args.threadId,
      runId: storageRunId,
      callId: args.ready.functionCall.callId,
      toolName: args.ready.functionCall.name,
      output,
    }),
  });
  return resultRef;
}

export async function readToolResultReady(args: {
  stateRoot: string;
  threadId: string;
  runId: string;
  resultRef: string;
}): Promise<ToolResultReadyReadResult> {
  const snapshotResult = await readToolOutputSnapshot({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    outputRef: args.resultRef,
  });
  if (!snapshotResult.ok) {
    return { ok: false, message: snapshotResult.message };
  }
  const parsed = tryParseJson(snapshotResult.value.output);
  const ready = parseDurableToolResultReady(parsed.ok ? parsed.value : null, {
    threadId: args.threadId,
    runId: args.runId,
  });
  if (ready === null) {
    return {
      ok: false,
      message: 'durable tool result readiness record is invalid',
    };
  }
  const expectedStorageRunId = buildToolResultReadyStorageRunId(args.runId);
  const expectedResultRef = buildToolOutputRef({
    threadId: args.threadId,
    runId: expectedStorageRunId,
    callId: ready.functionCall.callId,
  });
  if (
    snapshotResult.value.runId !== expectedStorageRunId ||
    snapshotResult.value.callId !== ready.functionCall.callId ||
    snapshotResult.value.toolName !== ready.functionCall.name ||
    args.resultRef !== expectedResultRef
  ) {
    return {
      ok: false,
      message: 'durable tool result readiness identity does not match',
    };
  }
  return { ok: true, value: ready };
}

export async function deleteToolResultReady(args: {
  stateRoot: string;
  threadId: string;
  resultRef: string;
}): Promise<boolean> {
  return await deleteToolOutputSnapshot({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    outputRef: args.resultRef,
  });
}

function buildToolResultReadyStorageRunId(runId: string): string {
  return `${TOOL_RESULT_READY_RUN_ID_PREFIX}${runId}`;
}

function parseDurableToolResultReady(
  value: unknown,
  identity: { threadId: string; runId: string },
): DurableToolResultReady | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== TOOL_RESULT_READY_SCHEMA_VERSION ||
    value.threadId !== identity.threadId ||
    value.runId !== identity.runId ||
    !Number.isSafeInteger(value.round) ||
    typeof value.round !== 'number' ||
    value.round < 0 ||
    typeof value.computerFilesMayHaveChanged !== 'boolean'
  ) {
    return null;
  }
  const functionCall = parseFunctionCall(value.functionCall);
  const toolResult = parseExecuteResult(value.toolResult);
  const source =
    value.source === undefined ? undefined : parseToolCallSource(value.source);
  const historyMode =
    value.historyMode === undefined
      ? undefined
      : value.historyMode === 'model_visible' ||
          value.historyMode === 'audit_only'
        ? value.historyMode
        : null;
  if (
    functionCall === null ||
    toolResult === null ||
    source === null ||
    historyMode === null
  ) {
    return null;
  }
  return {
    functionCall,
    round: value.round,
    toolResult,
    computerFilesMayHaveChanged: value.computerFilesMayHaveChanged,
    ...(source === undefined ? {} : { source }),
    ...(historyMode === undefined ? {} : { historyMode }),
  };
}

function parseFunctionCall(value: unknown): FunctionCall | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.callId !== 'string' ||
    value.callId.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.arguments !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    callId: value.callId,
    name: value.name,
    arguments: value.arguments,
  };
}

function parseToolCallSource(value: unknown): ToolCallSource | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === 'agent_loop') {
    return { kind: 'agent_loop' };
  }
  if (
    value.kind === 'ptc_callback' &&
    typeof value.parentToolCallId === 'string' &&
    typeof value.runtimeToolCallId === 'string' &&
    typeof value.hostCallId === 'string' &&
    (value.cellId === undefined || typeof value.cellId === 'string') &&
    (value.approvalClass === undefined ||
      typeof value.approvalClass === 'string')
  ) {
    return {
      kind: value.kind,
      parentToolCallId: value.parentToolCallId,
      runtimeToolCallId: value.runtimeToolCallId,
      hostCallId: value.hostCallId,
      ...(value.cellId === undefined ? {} : { cellId: value.cellId }),
      ...(value.approvalClass === undefined
        ? {}
        : { approvalClass: value.approvalClass }),
    };
  }
  if (
    value.kind === 'artifact_frame' &&
    typeof value.scopeHandle === 'string' &&
    typeof value.runtimeToolCallId === 'string' &&
    typeof value.hostCallId === 'string' &&
    (value.cellId === undefined || typeof value.cellId === 'string') &&
    (value.approvalClass === undefined ||
      typeof value.approvalClass === 'string')
  ) {
    return {
      kind: value.kind,
      scopeHandle: value.scopeHandle,
      runtimeToolCallId: value.runtimeToolCallId,
      hostCallId: value.hostCallId,
      ...(value.cellId === undefined ? {} : { cellId: value.cellId }),
      ...(value.approvalClass === undefined
        ? {}
        : { approvalClass: value.approvalClass }),
    };
  }
  return null;
}
