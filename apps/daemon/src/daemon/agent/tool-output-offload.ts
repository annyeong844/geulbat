import { isRecord, tryParseJson } from '../runtime-json.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { FunctionCall } from '../llm/index.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';
import type { ExecuteResult } from '../tools/types.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  type ToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';

const logger = createLogger('tool-output-offload');

interface ToolOutputOffloadArgs {
  functionCall: FunctionCall;
  runContext: RunWorkspaceContext;
  runId: string;
  toolOutputRecoveryAvailable?: boolean;
  toolResult: ExecuteResult;
}

interface SearchFilesSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'search_files';
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
}

interface SearchMemoryIndexSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'search_memory_index';
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  total: number | null;
  stale: boolean | null;
}

interface WebFetchSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'web_fetch';
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  url: string | null;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  title: string | null;
}

interface ListFilesSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'list_files';
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  path: string | null;
  total: number | null;
}

export async function maybeOffloadToolResult(
  args: ToolOutputOffloadArgs,
): Promise<ExecuteResult> {
  const { functionCall, runContext, runId, toolResult } = args;
  if (!toolResult.ok) {
    return toolResult;
  }

  const recoveryAvailable = args.toolOutputRecoveryAvailable ?? true;
  const wantsOffload = shouldOffloadToolOutput(functionCall.name);
  const wantsRecoverableRef = shouldAttachRecoverableOutputRef(
    functionCall.name,
  );
  const shouldOffload = wantsOffload && recoveryAvailable;
  const shouldAttachRecoverableRef = wantsRecoverableRef && recoveryAvailable;
  if (!shouldOffload && !shouldAttachRecoverableRef) {
    return toolResult;
  }

  const outputRef = buildToolOutputRef({
    callId: functionCall.callId,
    runId,
    threadId: runContext.threadId,
  });
  const parsedOutput = tryParseJson(toolResult.output);
  const parsedArguments = tryParseJson(functionCall.arguments);
  const source = readToolOutputSource(
    functionCall.name,
    parsedOutput,
    parsedArguments,
  );
  const snapshot = buildToolOutputSnapshot({
    outputRef,
    projectId: runContext.projectId,
    threadId: runContext.threadId,
    runId,
    callId: functionCall.callId,
    toolName: functionCall.name,
    output: toolResult.output,
    ...(source ? { source } : {}),
  });

  try {
    await writeToolOutputSnapshot({
      workspaceRoot: runContext.workspaceRoot,
      snapshot,
    });
  } catch {
    const action = shouldOffload ? 'offload' : 'record';
    logger.warn(`failed to ${action} tool output snapshot:`, {
      callId: functionCall.callId,
      runId,
      threadId: runContext.threadId,
      toolName: functionCall.name,
    });
    if (shouldAttachRecoverableRef && !shouldOffload) {
      return toolResult;
    }
    return {
      ok: false,
      output: '',
      errorCode: 'internal',
      error: `failed to ${action} tool output snapshot; full output was not recorded.`,
    };
  }

  if (shouldAttachRecoverableRef) {
    return buildRecoverableInlineResult({
      snapshot,
      toolResult,
    });
  }

  return {
    ok: true,
    output: JSON.stringify(buildSlimOutput(snapshot)),
  };
}

function shouldOffloadToolOutput(toolName: string): boolean {
  return (
    toolName === 'search_files' ||
    toolName === 'search_memory_index' ||
    toolName === 'web_fetch' ||
    toolName === 'list_files'
  );
}

function shouldAttachRecoverableOutputRef(toolName: string): boolean {
  return toolName === 'exec' || toolName === 'wait';
}

function buildRecoverableInlineResult(args: {
  snapshot: ToolOutputSnapshot;
  toolResult: ExecuteResult & { ok: true };
}): ExecuteResult {
  const parsed = tryParseJson(args.toolResult.output);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return args.toolResult;
  }

  return {
    ok: true,
    output: JSON.stringify({
      ...parsed.value,
      outputRef: args.snapshot.outputRef,
      fullOutputBytes: args.snapshot.fullOutputBytes,
      fullOutputChars: args.snapshot.fullOutputChars,
    }),
  };
}

function readToolOutputSource(
  toolName: string,
  parsedOutput: ReturnType<typeof tryParseJson>,
  parsedArguments: ReturnType<typeof tryParseJson>,
): ToolOutputSnapshot['source'] | undefined {
  const outputRecord =
    parsedOutput.ok && isRecord(parsedOutput.value) ? parsedOutput.value : null;
  const argumentsRecord =
    parsedArguments.ok && isRecord(parsedArguments.value)
      ? parsedArguments.value
      : null;
  if (toolName === 'search_files') {
    const query =
      readStringField(argumentsRecord, 'query') ??
      readStringField(outputRecord, 'query');
    return query === undefined ? undefined : { query };
  }
  if (toolName === 'search_memory_index') {
    const query = readStringField(argumentsRecord, 'query');
    return query === undefined ? undefined : { query };
  }
  if (toolName === 'list_files') {
    const path = readStringField(outputRecord, 'path');
    return path === undefined ? undefined : { path };
  }
  if (toolName === 'web_fetch') {
    const source: ToolOutputSnapshot['source'] = {};
    const url = readStringField(outputRecord, 'url');
    if (url !== undefined) {
      source.url = url;
    }
    const finalUrl = readStringField(outputRecord, 'finalUrl');
    if (finalUrl !== undefined) {
      source.finalUrl = finalUrl;
    }
    return Object.keys(source).length > 0 ? source : undefined;
  }
  return undefined;
}

function readStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function buildSlimOutput(
  snapshot: ToolOutputSnapshot,
):
  | SearchFilesSlimOutput
  | SearchMemoryIndexSlimOutput
  | WebFetchSlimOutput
  | ListFilesSlimOutput {
  if (snapshot.toolName === 'web_fetch') {
    return buildWebFetchSlimOutput(snapshot);
  }
  if (snapshot.toolName === 'list_files') {
    return buildListFilesSlimOutput(snapshot);
  }
  if (snapshot.toolName === 'search_memory_index') {
    return buildSearchMemoryIndexSlimOutput(snapshot);
  }
  return buildSearchFilesSlimOutput(snapshot);
}

function buildSearchFilesSlimOutput(
  snapshot: ToolOutputSnapshot,
): SearchFilesSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  return {
    ok: true,
    offloaded: true,
    tool: 'search_files',
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildSearchFilesSummary(parsed.ok ? parsed.value : null),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
  };
}

function buildSearchMemoryIndexSlimOutput(
  snapshot: ToolOutputSnapshot,
): SearchMemoryIndexSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  return {
    ok: true,
    offloaded: true,
    tool: 'search_memory_index',
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildSearchMemoryIndexSummary(record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    total: record && typeof record.total === 'number' ? record.total : null,
    stale: record && typeof record.stale === 'boolean' ? record.stale : null,
  };
}

function buildWebFetchSlimOutput(
  snapshot: ToolOutputSnapshot,
): WebFetchSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const finalUrl =
    record && typeof record.finalUrl === 'string' ? record.finalUrl : null;
  const url = record && typeof record.url === 'string' ? record.url : null;
  const title =
    record && typeof record.title === 'string' ? record.title : null;

  return {
    ok: true,
    offloaded: true,
    tool: 'web_fetch',
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildWebFetchSummary(record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    url,
    finalUrl,
    status: record && typeof record.status === 'number' ? record.status : null,
    contentType:
      record && typeof record.contentType === 'string'
        ? record.contentType
        : null,
    title,
  };
}

function buildListFilesSlimOutput(
  snapshot: ToolOutputSnapshot,
): ListFilesSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  return {
    ok: true,
    offloaded: true,
    tool: 'list_files',
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildListFilesSummary(record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    path: record && typeof record.path === 'string' ? record.path : null,
    total: record && typeof record.total === 'number' ? record.total : null,
  };
}

function buildListFilesSummary(record: Record<string, unknown> | null): string {
  if (!record) {
    return 'list_files returned a large listing. Full output was written to the tool output snapshot.';
  }
  const path =
    typeof record.path === 'string' ? record.path : 'an unknown path';
  const total =
    typeof record.total === 'number'
      ? `${record.total} ${record.total === 1 ? 'entry' : 'entries'}`
      : 'a large listing';
  return `list_files returned ${total} for ${path}. Full output was written to the tool output snapshot.`;
}

function buildWebFetchSummary(record: Record<string, unknown> | null): string {
  if (!record) {
    return 'web_fetch returned a large response. Full output was written to the tool output snapshot.';
  }
  const finalUrl =
    typeof record.finalUrl === 'string' ? record.finalUrl : 'an unknown URL';
  const title =
    typeof record.title === 'string' ? ` titled "${record.title}"` : '';
  return `web_fetch returned a large response from ${finalUrl}${title}. Full output was written to the tool output snapshot.`;
}

function buildSearchMemoryIndexSummary(
  record: Record<string, unknown> | null,
): string {
  if (!record) {
    return 'search_memory_index returned memory matches. Full output was written to the tool output snapshot.';
  }
  const total =
    typeof record.total === 'number'
      ? `${record.total} ${record.total === 1 ? 'match' : 'matches'}`
      : 'memory matches';
  const stale = record.stale === true ? ' The memory index was stale.' : '';
  return `search_memory_index returned ${total}.${stale} Full output was written to the tool output snapshot.`;
}

function buildSearchFilesSummary(value: unknown): string {
  if (!isRecord(value)) {
    return 'search_files returned a large result. Full output was written to the tool output snapshot.';
  }

  const total = typeof value.total === 'number' ? value.total : null;
  const truncated = value.truncated === true;
  const countLabel =
    total === null
      ? 'a large result'
      : `${total} ${total === 1 ? 'match' : 'matches'}`;
  const recordedLabel = Array.isArray(value.results)
    ? ` The snapshot records ${value.results.length} result ${value.results.length === 1 ? 'entry' : 'entries'}.`
    : '';
  const truncatedLabel = truncated ? ' The search result was truncated.' : '';
  return `search_files returned ${countLabel}.${truncatedLabel}${recordedLabel} Full output was written to the tool output snapshot.`;
}
