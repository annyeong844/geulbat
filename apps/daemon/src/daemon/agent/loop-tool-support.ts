import { isRecord, tryParseJson } from '../runtime-json.js';
import type { HistoryItem, FunctionCall } from '../llm/index.js';
import { toolError } from '../tools/result.js';
import type {
  ExecuteResult,
  ToolRecoveryStrategy,
  ToolResultProjectionCapability,
} from '../tools/types.js';
import {
  appendTranscriptEntries,
  appendTranscriptEntry,
} from '../sessions/transcript-log.js';
import type { AgentEventEmitter, ToolCallArgs } from './events.js';
import type { ErrorCode } from '../error-codes.js';
import type { RunContext } from '../run-context.js';
import { measureResponseWireFunctionCallOutputAppendBytes } from '../llm/provider/transport/responses-wire-input.js';
import {
  maybeOffloadToolResult,
  type ToolOutputProjectionRound,
} from './tool-output-offload.js';
import type { ToolCallSource } from './tool-call-source.js';
import type { ToolResultObservation } from './observer/agent-loop-observer.js';

type TranscriptContext = RunContext;

interface TranscriptToolCallRecord {
  id: string;
  callId: string;
  tool: string;
  args: ToolCallArgs;
  round: number;
  recoveryStrategy?: ToolRecoveryStrategy;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
}

interface TranscriptToolResultRecord {
  callId: string;
  tool: string;
  ok: boolean;
  computerFilesMayHaveChanged: boolean;
  displayText: string;
  output: string;
  errorCode?: ErrorCode;
  error?: string;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
}

interface RecordToolCallInput {
  functionCall: FunctionCall;
  round: number;
  toolArgs: ToolCallArgs;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
  recoveryStrategy?: ToolRecoveryStrategy;
}

interface RecordToolResultInput {
  functionCall: FunctionCall;
  round: number;
  toolResult: ExecuteResult;
  toolOutputRecoveryAvailable?: boolean;
  resultProjection?: ToolResultProjectionCapability;
  elapsedMs?: number | null;
  computerFilesMayHaveChanged: boolean;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
}

interface RecordToolResultContext {
  runContext: TranscriptContext;
  runId: string;
  history: HistoryItem[];
  emit: AgentEventEmitter;
  projectionRound?: ToolOutputProjectionRound | undefined;
  observeToolResult?: (observation: ToolResultObservation) => void;
}

interface ToolResultTranscriptEntry {
  role: 'tool_result';
  content: string;
  timestamp: string;
}

export function parseToolCallArguments(
  argumentsJson: string,
): { ok: true; args: ToolCallArgs } | { ok: false; error: ExecuteResult } {
  const parsed = tryParseJson(argumentsJson);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {
      ok: false,
      error: toolError('invalid_args', 'arguments JSON parse failed'),
    };
  }
  return { ok: true, args: parsed.value };
}

function buildFunctionCallOutput(
  toolResult: ExecuteResult,
  parsedResult: unknown,
): string {
  if (toolResult.ok) {
    return toolResult.output;
  }

  return JSON.stringify({
    ok: false,
    errorCode: toolResult.errorCode,
    error: toolResult.error,
    ...(toolResult.output.length === 0 ? {} : { details: parsedResult }),
  });
}

function parseToolResultRaw(output: string): unknown {
  const parsed = tryParseJson(output);
  return parsed.ok ? parsed.value : output;
}

function formatDisplayText(
  ok: boolean,
  output: string,
  error?: string,
): string {
  if (!ok) {
    return error ?? 'execution failed';
  }
  return output;
}

type ToolResultHistoryMode = 'model_visible' | 'audit_only';

function projectAuditOnlyReadToolOutputResult(
  functionCall: FunctionCall,
  toolResult: ExecuteResult,
  historyMode: ToolResultHistoryMode,
): ExecuteResult {
  if (
    historyMode !== 'audit_only' ||
    functionCall.name !== 'read_tool_output' ||
    !toolResult.ok
  ) {
    return toolResult;
  }
  const parsed = tryParseJson(toolResult.output);
  if (
    !parsed.ok ||
    !isRecord(parsed.value) ||
    parsed.value['ok'] !== true ||
    typeof parsed.value['outputRef'] !== 'string'
  ) {
    return toolResult;
  }

  const auditRecord = { ...parsed.value };
  if (typeof parsed.value['content'] === 'string') {
    const content = parsed.value['content'];
    delete auditRecord['content'];
    return {
      ok: true,
      output: JSON.stringify({
        ...auditRecord,
        auditProjection: 'read_tool_output_page_ref_v1',
        contentOmittedFromAudit: true,
        contentChars: content.length,
        contentBytes: Buffer.byteLength(content, 'utf8'),
      }),
    };
  }
  if (Array.isArray(parsed.value['items'])) {
    const items = parsed.value['items'];
    const serializedItems = JSON.stringify(items);
    delete auditRecord['items'];
    return {
      ok: true,
      output: JSON.stringify({
        ...auditRecord,
        auditProjection: 'read_tool_output_item_page_ref_v1',
        itemsOmittedFromAudit: true,
        itemCount: items.length,
        itemsChars: serializedItems.length,
        itemsBytes: Buffer.byteLength(serializedItems, 'utf8'),
      }),
    };
  }
  return toolResult;
}

function toToolCallSourcePayload(source: ToolCallSource | undefined) {
  if (source?.kind === 'artifact_frame') {
    return {
      kind: 'artifact_frame' as const,
      scopeHandle: source.scopeHandle,
      runtimeToolCallId: source.runtimeToolCallId,
    };
  }
  if (source?.kind !== 'ptc_callback') {
    return undefined;
  }
  return {
    kind: 'ptc_callback' as const,
    parentCallId: source.parentToolCallId,
    runtimeToolCallId: source.runtimeToolCallId,
    ...(source.cellId !== undefined ? { cellId: source.cellId } : {}),
  };
}

async function appendToolResultTranscriptEntry(
  runContext: TranscriptContext,
  record: TranscriptToolResultRecord,
  pendingEntries?: ToolResultTranscriptEntry[],
): Promise<void> {
  const entry: ToolResultTranscriptEntry = {
    role: 'tool_result',
    content: JSON.stringify(record),
    timestamp: new Date().toISOString(),
  };
  if (pendingEntries) {
    pendingEntries.push(entry);
    return;
  }
  await appendTranscriptEntry(runContext.stateRoot, runContext.threadId, entry);
}

async function emitAndPersistToolResult(
  args: RecordToolResultInput &
    RecordToolResultContext & {
      pendingTranscriptEntries?: ToolResultTranscriptEntry[];
    },
): Promise<void> {
  const {
    functionCall,
    round,
    toolResult,
    toolOutputRecoveryAvailable,
    computerFilesMayHaveChanged,
    runContext,
    runId,
    history,
    emit,
    source,
    historyMode = 'model_visible',
    projectionRound,
    observeToolResult,
    pendingTranscriptEntries,
  } = args;
  const sourcePayload = toToolCallSourcePayload(source);
  const auditProjectedToolResult = projectAuditOnlyReadToolOutputResult(
    functionCall,
    toolResult,
    historyMode,
  );
  const recordedToolResult = await maybeOffloadToolResult({
    functionCall,
    runContext,
    runId,
    ...(toolOutputRecoveryAvailable !== undefined
      ? { toolOutputRecoveryAvailable }
      : {}),
    ...(args.resultProjection === undefined
      ? {}
      : { resultProjection: args.resultProjection }),
    ...(args.elapsedMs === undefined ? {} : { elapsedMs: args.elapsedMs }),
    ...(projectionRound === undefined ? {} : { projectionRound }),
    ...(observeToolResult === undefined ? {} : { observeToolResult }),
    measureModelVisibleResultBytes(candidate: ExecuteResult) {
      const parsedCandidate = parseToolResultRaw(candidate.output);
      return measureResponseWireFunctionCallOutputAppendBytes({
        kind: 'function_call_output',
        callId: functionCall.callId,
        output: buildFunctionCallOutput(candidate, parsedCandidate),
      });
    },
    toolResult: auditProjectedToolResult,
  });
  const parsedResult = parseToolResultRaw(recordedToolResult.output);
  const modelOutput = buildFunctionCallOutput(recordedToolResult, parsedResult);
  let readToolOutputAuditDisplayText: string | null = null;
  if (
    historyMode === 'audit_only' &&
    functionCall.name === 'read_tool_output' &&
    isRecord(parsedResult)
  ) {
    if (parsedResult['auditProjection'] === 'read_tool_output_page_ref_v1') {
      readToolOutputAuditDisplayText = `read_tool_output audit page ${String(parsedResult['offset'])}-${String(parsedResult['endOffset'])} of ${String(parsedResult['totalChars'])}; content omitted; outputRef=${String(parsedResult['outputRef'])}`;
    } else if (
      parsedResult['auditProjection'] === 'read_tool_output_item_page_ref_v1'
    ) {
      readToolOutputAuditDisplayText = `read_tool_output audit item page ${String(parsedResult['offset'])}-${String(parsedResult['endOffset'])} of ${String(parsedResult['totalItems'])}; items omitted; outputRef=${String(parsedResult['outputRef'])}`;
    }
  }
  const displayText =
    readToolOutputAuditDisplayText ??
    formatDisplayText(
      recordedToolResult.ok,
      recordedToolResult.output,
      recordedToolResult.ok ? undefined : recordedToolResult.error,
    );
  if (recordedToolResult.ok) {
    emit('tool_result', {
      callId: functionCall.callId,
      step: round,
      tool: functionCall.name,
      ok: true,
      computerFilesMayHaveChanged,
      displayText,
      raw: parsedResult,
      ...(sourcePayload ? { source: sourcePayload } : {}),
    });
  } else {
    const errorCode = recordedToolResult.errorCode ?? 'execution_failed';
    const error =
      recordedToolResult.error ?? 'tool failed without an error message';
    emit('tool_result', {
      callId: functionCall.callId,
      step: round,
      tool: functionCall.name,
      ok: false,
      computerFilesMayHaveChanged,
      displayText,
      raw: parsedResult,
      errorCode,
      error,
      ...(sourcePayload ? { source: sourcePayload } : {}),
    });

    if (historyMode === 'model_visible') {
      history.push({
        kind: 'function_call_output',
        callId: functionCall.callId,
        output: modelOutput,
      });
    }

    await appendToolResultTranscriptEntry(
      runContext,
      {
        callId: functionCall.callId,
        tool: functionCall.name,
        ok: false,
        computerFilesMayHaveChanged,
        displayText,
        output: modelOutput,
        errorCode,
        error,
        ...(source ? { source } : {}),
        ...(historyMode !== 'model_visible' ? { historyMode } : {}),
      },
      pendingTranscriptEntries,
    );
    return;
  }

  if (historyMode === 'model_visible') {
    history.push({
      kind: 'function_call_output',
      callId: functionCall.callId,
      output: modelOutput,
    });
  }

  await appendToolResultTranscriptEntry(
    runContext,
    {
      callId: functionCall.callId,
      tool: functionCall.name,
      ok: true,
      computerFilesMayHaveChanged,
      displayText,
      output: modelOutput,
      ...(source ? { source } : {}),
      ...(historyMode !== 'model_visible' ? { historyMode } : {}),
    },
    pendingTranscriptEntries,
  );
}

export async function recordToolCalls(args: {
  calls: readonly RecordToolCallInput[];
  runContext: TranscriptContext;
  emit: AgentEventEmitter;
}): Promise<void> {
  const transcriptEntries = args.calls.map((call) => {
    const sourcePayload = toToolCallSourcePayload(call.source);
    args.emit('tool_call', {
      callId: call.functionCall.callId,
      step: call.round,
      tool: call.functionCall.name,
      args: call.toolArgs,
      ...(sourcePayload ? { source: sourcePayload } : {}),
    });
    const record: TranscriptToolCallRecord = {
      id: call.functionCall.id,
      callId: call.functionCall.callId,
      tool: call.functionCall.name,
      args: call.toolArgs,
      round: call.round,
      ...(call.recoveryStrategy
        ? { recoveryStrategy: call.recoveryStrategy }
        : {}),
      ...(call.source ? { source: call.source } : {}),
      ...(call.historyMode && call.historyMode !== 'model_visible'
        ? { historyMode: call.historyMode }
        : {}),
    };
    return {
      role: 'tool_call' as const,
      content: JSON.stringify(record),
      timestamp: new Date().toISOString(),
    };
  });
  await appendTranscriptEntries(
    args.runContext.stateRoot,
    args.runContext.threadId,
    transcriptEntries,
  );
}

export async function recordToolCall(
  args: RecordToolCallInput & {
    runContext: TranscriptContext;
    emit: AgentEventEmitter;
  },
): Promise<void> {
  await recordToolCalls({
    calls: [args],
    runContext: args.runContext,
    emit: args.emit,
  });
}

export async function recordToolResults(
  args: RecordToolResultContext & {
    results: readonly RecordToolResultInput[];
  },
): Promise<void> {
  const { results, ...context } = args;
  const pendingTranscriptEntries: ToolResultTranscriptEntry[] = [];
  for (const result of results) {
    await emitAndPersistToolResult({
      ...context,
      ...result,
      pendingTranscriptEntries,
    });
  }
  await appendTranscriptEntries(
    context.runContext.stateRoot,
    context.runContext.threadId,
    pendingTranscriptEntries,
  );
}

export async function recordToolResult(
  args: RecordToolResultInput & RecordToolResultContext,
): Promise<void> {
  await emitAndPersistToolResult(args);
}

export async function recordInvalidToolArguments(args: {
  functionCall: FunctionCall;
  round: number;
  errorResult: ExecuteResult;
  toolOutputRecoveryAvailable?: boolean;
  resultProjection?: ToolResultProjectionCapability;
  runContext: TranscriptContext;
  runId: string;
  history: HistoryItem[];
  emit: AgentEventEmitter;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
  projectionRound?: ToolOutputProjectionRound | undefined;
  observeToolResult?: (observation: ToolResultObservation) => void;
}): Promise<void> {
  const {
    functionCall,
    round,
    errorResult,
    runContext,
    runId,
    history,
    emit,
    source,
    historyMode,
  } = args;
  await recordToolCall({
    functionCall,
    round,
    toolArgs: {},
    runContext,
    emit,
    ...(source ? { source } : {}),
    ...(historyMode && historyMode !== 'model_visible' ? { historyMode } : {}),
  });
  await emitAndPersistToolResult({
    functionCall,
    round,
    toolResult: errorResult,
    ...(args.toolOutputRecoveryAvailable !== undefined
      ? { toolOutputRecoveryAvailable: args.toolOutputRecoveryAvailable }
      : {}),
    ...(args.resultProjection === undefined
      ? {}
      : { resultProjection: args.resultProjection }),
    ...(args.projectionRound === undefined
      ? {}
      : { projectionRound: args.projectionRound }),
    ...(args.observeToolResult === undefined
      ? {}
      : { observeToolResult: args.observeToolResult }),
    computerFilesMayHaveChanged: false,
    runContext,
    runId,
    history,
    emit,
    ...(source ? { source } : {}),
    ...(historyMode ? { historyMode } : {}),
  });
}
