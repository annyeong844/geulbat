import { isRecord, tryParseJson } from '@geulbat/protocol/runtime-utils';
import type { HistoryItem, FunctionCall } from '../llm/index.js';
import { toolError } from '../tools/result.js';
import type { ExecuteResult } from '../tools/types.js';
import { appendTranscriptEntry } from '../sessions/transcript-log.js';
import type { AgentEventEmitter, ToolCallArgs } from './events.js';
import type { ErrorCode } from '../error-codes.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';

type TranscriptContext = Pick<
  RunWorkspaceContext,
  'workspaceRoot' | 'threadId'
>;

interface TranscriptToolCallRecord {
  id: string;
  callId: string;
  tool: string;
  args: ToolCallArgs;
}

interface TranscriptToolResultRecord {
  callId: string;
  tool: string;
  ok: boolean;
  workspaceFilesMayHaveChanged: boolean;
  displayText: string;
  output: string;
  errorCode?: ErrorCode;
  error?: string;
}

const MAX_TOOL_RESULT_DISPLAY_TEXT_LENGTH = 300;

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
  if (!ok) return error ?? 'execution failed';
  return output.length <= MAX_TOOL_RESULT_DISPLAY_TEXT_LENGTH
    ? output
    : output.slice(0, MAX_TOOL_RESULT_DISPLAY_TEXT_LENGTH) + '...(truncated)';
}

async function appendToolCallTranscriptEntry(
  runContext: TranscriptContext,
  record: TranscriptToolCallRecord,
): Promise<void> {
  await appendTranscriptEntry(runContext.workspaceRoot, runContext.threadId, {
    role: 'tool_call',
    content: JSON.stringify(record),
    timestamp: new Date().toISOString(),
  });
}

async function appendToolResultTranscriptEntry(
  runContext: TranscriptContext,
  record: TranscriptToolResultRecord,
): Promise<void> {
  await appendTranscriptEntry(runContext.workspaceRoot, runContext.threadId, {
    role: 'tool_result',
    content: JSON.stringify(record),
    timestamp: new Date().toISOString(),
  });
}

async function emitAndPersistToolResult(args: {
  functionCall: FunctionCall;
  round: number;
  toolResult: ExecuteResult;
  workspaceFilesMayHaveChanged: boolean;
  runContext: TranscriptContext;
  history: HistoryItem[];
  emit: AgentEventEmitter;
}): Promise<void> {
  const {
    functionCall,
    round,
    toolResult,
    workspaceFilesMayHaveChanged,
    runContext,
    history,
    emit,
  } = args;
  const parsedResult = parseToolResultRaw(toolResult.output);
  const displayText = formatDisplayText(
    toolResult.ok,
    toolResult.output,
    toolResult.ok ? undefined : toolResult.error,
  );
  if (toolResult.ok) {
    emit('tool_result', {
      callId: functionCall.callId,
      step: round,
      tool: functionCall.name,
      ok: true,
      workspaceFilesMayHaveChanged,
      displayText,
      raw: parsedResult,
    });
  } else {
    const errorCode = toolResult.errorCode ?? 'execution_failed';
    const error = toolResult.error ?? 'tool failed without an error message';
    emit('tool_result', {
      callId: functionCall.callId,
      step: round,
      tool: functionCall.name,
      ok: false,
      workspaceFilesMayHaveChanged,
      displayText,
      raw: parsedResult,
      errorCode,
      error,
    });

    history.push({
      kind: 'function_call_output',
      callId: functionCall.callId,
      output: buildFunctionCallOutput(toolResult),
    });

    await appendToolResultTranscriptEntry(runContext, {
      callId: functionCall.callId,
      tool: functionCall.name,
      ok: false,
      workspaceFilesMayHaveChanged,
      displayText,
      output: toolResult.output,
      errorCode,
      error,
    });
    return;
  }

  history.push({
    kind: 'function_call_output',
    callId: functionCall.callId,
    output: buildFunctionCallOutput(toolResult),
  });

  await appendToolResultTranscriptEntry(runContext, {
    callId: functionCall.callId,
    tool: functionCall.name,
    ok: true,
    workspaceFilesMayHaveChanged,
    displayText,
    output: toolResult.output,
  });
}

export async function recordToolCall(args: {
  functionCall: FunctionCall;
  round: number;
  toolArgs: ToolCallArgs;
  runContext: TranscriptContext;
  emit: AgentEventEmitter;
}): Promise<void> {
  const { functionCall, round, toolArgs, runContext, emit } = args;
  emit('tool_call', {
    callId: functionCall.callId,
    step: round,
    tool: functionCall.name,
    args: toolArgs,
  });

  await appendToolCallTranscriptEntry(runContext, {
    id: functionCall.id,
    callId: functionCall.callId,
    tool: functionCall.name,
    args: toolArgs,
  });
}

export async function recordToolResult(args: {
  functionCall: FunctionCall;
  round: number;
  toolResult: ExecuteResult;
  workspaceFilesMayHaveChanged: boolean;
  runContext: TranscriptContext;
  history: HistoryItem[];
  emit: AgentEventEmitter;
}): Promise<void> {
  await emitAndPersistToolResult(args);
}

export async function recordInvalidToolArguments(args: {
  functionCall: FunctionCall;
  round: number;
  errorResult: ExecuteResult;
  runContext: TranscriptContext;
  history: HistoryItem[];
  emit: AgentEventEmitter;
}): Promise<void> {
  const { functionCall, round, errorResult, runContext, history, emit } = args;
  emit('tool_call', {
    callId: functionCall.callId,
    step: round,
    tool: functionCall.name,
    args: {},
  });
  await appendToolCallTranscriptEntry(runContext, {
    id: functionCall.id,
    callId: functionCall.callId,
    tool: functionCall.name,
    args: {},
  });
  await emitAndPersistToolResult({
    functionCall,
    round,
    toolResult: errorResult,
    workspaceFilesMayHaveChanged: false,
    runContext,
    history,
    emit,
  });
}
