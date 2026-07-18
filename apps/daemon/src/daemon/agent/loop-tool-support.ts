import { isRecord, tryParseJson } from '../runtime-json.js';
import type { HistoryItem, FunctionCall } from '../llm/index.js';
import { toolError } from '../tools/result.js';
import type { ExecuteResult, ToolRecoveryStrategy } from '../tools/types.js';
import { appendTranscriptEntry } from '../sessions/transcript-log.js';
import type { AgentEventEmitter, ToolCallArgs } from './events.js';
import type { ErrorCode } from '../error-codes.js';
import type { RunContext } from '../run-context.js';
import { maybeOffloadToolResult } from './tool-output-offload.js';
import type { ToolCallSource } from './tool-call-source.js';

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

function buildFunctionCallOutput(toolResult: ExecuteResult): string {
  return toolResult.ok
    ? toolResult.output
    : JSON.stringify({
        ok: false,
        errorCode: toolResult.errorCode,
        error: toolResult.error,
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
    typeof parsed.value['outputRef'] !== 'string' ||
    typeof parsed.value['content'] !== 'string'
  ) {
    return toolResult;
  }

  const auditRecord = { ...parsed.value };
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

async function appendToolCallTranscriptEntry(
  runContext: TranscriptContext,
  record: TranscriptToolCallRecord,
): Promise<void> {
  await appendTranscriptEntry(runContext.stateRoot, runContext.threadId, {
    role: 'tool_call',
    content: JSON.stringify(record),
    timestamp: new Date().toISOString(),
  });
}

async function appendToolResultTranscriptEntry(
  runContext: TranscriptContext,
  record: TranscriptToolResultRecord,
): Promise<void> {
  await appendTranscriptEntry(runContext.stateRoot, runContext.threadId, {
    role: 'tool_result',
    content: JSON.stringify(record),
    timestamp: new Date().toISOString(),
  });
}

async function emitAndPersistToolResult(args: {
  functionCall: FunctionCall;
  round: number;
  toolResult: ExecuteResult;
  toolOutputRecoveryAvailable?: boolean;
  computerFilesMayHaveChanged: boolean;
  runContext: TranscriptContext;
  runId: string;
  history: HistoryItem[];
  emit: AgentEventEmitter;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
}): Promise<void> {
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
    toolResult: auditProjectedToolResult,
  });
  const modelOutput = buildFunctionCallOutput(recordedToolResult);
  const parsedResult = parseToolResultRaw(recordedToolResult.output);
  const displayText =
    historyMode === 'audit_only' &&
    functionCall.name === 'read_tool_output' &&
    isRecord(parsedResult) &&
    parsedResult['auditProjection'] === 'read_tool_output_page_ref_v1'
      ? `read_tool_output audit page ${String(parsedResult['offset'])}-${String(parsedResult['endOffset'])} of ${String(parsedResult['totalChars'])}; content omitted; outputRef=${String(parsedResult['outputRef'])}`
      : formatDisplayText(
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

    await appendToolResultTranscriptEntry(runContext, {
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
    });
    return;
  }

  if (historyMode === 'model_visible') {
    history.push({
      kind: 'function_call_output',
      callId: functionCall.callId,
      output: modelOutput,
    });
  }

  await appendToolResultTranscriptEntry(runContext, {
    callId: functionCall.callId,
    tool: functionCall.name,
    ok: true,
    computerFilesMayHaveChanged,
    displayText,
    output: modelOutput,
    ...(source ? { source } : {}),
    ...(historyMode !== 'model_visible' ? { historyMode } : {}),
  });
}

export async function recordToolCall(args: {
  functionCall: FunctionCall;
  round: number;
  toolArgs: ToolCallArgs;
  runContext: TranscriptContext;
  emit: AgentEventEmitter;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
  recoveryStrategy?: ToolRecoveryStrategy;
}): Promise<void> {
  const {
    functionCall,
    round,
    toolArgs,
    runContext,
    emit,
    source,
    historyMode,
    recoveryStrategy,
  } = args;
  const sourcePayload = toToolCallSourcePayload(source);
  emit('tool_call', {
    callId: functionCall.callId,
    step: round,
    tool: functionCall.name,
    args: toolArgs,
    ...(sourcePayload ? { source: sourcePayload } : {}),
  });

  await appendToolCallTranscriptEntry(runContext, {
    id: functionCall.id,
    callId: functionCall.callId,
    tool: functionCall.name,
    args: toolArgs,
    round,
    ...(recoveryStrategy ? { recoveryStrategy } : {}),
    ...(source ? { source } : {}),
    ...(historyMode && historyMode !== 'model_visible' ? { historyMode } : {}),
  });
}

export async function recordToolResult(args: {
  functionCall: FunctionCall;
  round: number;
  toolResult: ExecuteResult;
  toolOutputRecoveryAvailable?: boolean;
  computerFilesMayHaveChanged: boolean;
  runContext: TranscriptContext;
  runId: string;
  history: HistoryItem[];
  emit: AgentEventEmitter;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
}): Promise<void> {
  await emitAndPersistToolResult(args);
}

export async function recordInvalidToolArguments(args: {
  functionCall: FunctionCall;
  round: number;
  errorResult: ExecuteResult;
  toolOutputRecoveryAvailable?: boolean;
  runContext: TranscriptContext;
  runId: string;
  history: HistoryItem[];
  emit: AgentEventEmitter;
  source?: ToolCallSource;
  historyMode?: ToolResultHistoryMode;
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
  const sourcePayload = toToolCallSourcePayload(source);
  emit('tool_call', {
    callId: functionCall.callId,
    step: round,
    tool: functionCall.name,
    args: {},
    ...(sourcePayload ? { source: sourcePayload } : {}),
  });
  await appendToolCallTranscriptEntry(runContext, {
    id: functionCall.id,
    callId: functionCall.callId,
    tool: functionCall.name,
    args: {},
    round,
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
    computerFilesMayHaveChanged: false,
    runContext,
    runId,
    history,
    emit,
    ...(source ? { source } : {}),
    ...(historyMode ? { historyMode } : {}),
  });
}
