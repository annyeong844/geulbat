import { isRecord, tryParseJson } from '@geulbat/protocol/runtime-utils';
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

const TOOL_OUTPUT_OFFLOAD_MIN_OUTPUT_CHARS = 4_096;
const SEARCH_FILES_PREVIEW_RESULT_COUNT = 10;
const SEARCH_FILES_PREVIEW_TEXT_CHARS = 160;
const WEB_FETCH_PREVIEW_CHARS = 320;
const logger = createLogger('tool-output-offload');

interface ToolOutputOffloadArgs {
  functionCall: FunctionCall;
  runContext: RunWorkspaceContext;
  runId: string;
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
  preview: SearchFilesSlimPreviewItem[];
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
  preview: string;
}

interface SearchFilesSlimPreviewItem {
  path: string;
  line: number;
  text: string;
}

export async function maybeOffloadToolResult(
  args: ToolOutputOffloadArgs,
): Promise<ExecuteResult> {
  const { functionCall, runContext, runId, toolResult } = args;
  if (
    !toolResult.ok ||
    !shouldOffloadToolOutput(functionCall.name) ||
    toolResult.output.length <= TOOL_OUTPUT_OFFLOAD_MIN_OUTPUT_CHARS
  ) {
    return toolResult;
  }

  const outputRef = buildToolOutputRef({
    callId: functionCall.callId,
    runId,
    threadId: runContext.threadId,
  });
  const parsed = tryParseJson(toolResult.output);
  const source = readToolOutputSource(functionCall.name, parsed);
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
    logger.warn('failed to offload large tool output snapshot:', {
      callId: functionCall.callId,
      runId,
      threadId: runContext.threadId,
      toolName: functionCall.name,
    });
    return {
      ok: false,
      output: '',
      errorCode: 'internal',
      error:
        'failed to offload large tool output snapshot; full output was not recorded.',
    };
  }

  return {
    ok: true,
    output: JSON.stringify(buildSlimOutput(snapshot)),
  };
}

function shouldOffloadToolOutput(toolName: string): boolean {
  return toolName === 'search_files' || toolName === 'web_fetch';
}

function readToolOutputSource(
  toolName: string,
  parsed: ReturnType<typeof tryParseJson>,
): ToolOutputSnapshot['source'] | undefined {
  if (!parsed.ok || !isRecord(parsed.value)) {
    return undefined;
  }
  if (toolName === 'search_files' && typeof parsed.value.query === 'string') {
    return { query: parsed.value.query };
  }
  if (toolName === 'web_fetch') {
    const source: ToolOutputSnapshot['source'] = {};
    if (typeof parsed.value.url === 'string') {
      source.url = parsed.value.url;
    }
    if (typeof parsed.value.finalUrl === 'string') {
      source.finalUrl = parsed.value.finalUrl;
    }
    return Object.keys(source).length > 0 ? source : undefined;
  }
  return undefined;
}

function buildSlimOutput(
  snapshot: ToolOutputSnapshot,
): SearchFilesSlimOutput | WebFetchSlimOutput {
  if (snapshot.toolName === 'web_fetch') {
    return buildWebFetchSlimOutput(snapshot);
  }
  return buildSearchFilesSlimOutput(snapshot);
}

function buildSearchFilesSlimOutput(
  snapshot: ToolOutputSnapshot,
): SearchFilesSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const preview = buildSearchFilesPreview(parsed.ok ? parsed.value : null);
  return {
    ok: true,
    offloaded: true,
    tool: 'search_files',
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildSearchFilesSummary(parsed.ok ? parsed.value : null),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    preview,
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
  const content =
    record && typeof record.content === 'string' ? record.content : '';

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
    preview: truncateText(content, WEB_FETCH_PREVIEW_CHARS),
  };
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

function buildSearchFilesSummary(value: unknown): string {
  if (!isRecord(value)) {
    return 'search_files returned a large result. Full output was written to the tool output snapshot.';
  }

  const total = typeof value.total === 'number' ? value.total : null;
  const resultCount = Array.isArray(value.results)
    ? value.results.length
    : null;
  const truncated = value.truncated === true;
  const countLabel =
    total === null
      ? 'a large result'
      : `${total} ${total === 1 ? 'match' : 'matches'}`;
  const previewLabel =
    resultCount === null
      ? ''
      : ` Preview includes ${Math.min(resultCount, SEARCH_FILES_PREVIEW_RESULT_COUNT)} of ${resultCount} recorded results.`;
  const truncatedLabel = truncated ? ' The search result was truncated.' : '';
  return `search_files returned ${countLabel}.${truncatedLabel}${previewLabel} Full output was written to the tool output snapshot.`;
}

function buildSearchFilesPreview(value: unknown): SearchFilesSlimPreviewItem[] {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return [];
  }
  return value.results
    .slice(0, SEARCH_FILES_PREVIEW_RESULT_COUNT)
    .flatMap((result) => {
      if (!isRecord(result)) return [];
      const text = typeof result.text === 'string' ? result.text : '';
      return [
        {
          path: typeof result.path === 'string' ? result.path : '',
          line: typeof result.line === 'number' ? result.line : 0,
          text: truncateText(text, SEARCH_FILES_PREVIEW_TEXT_CHARS),
        },
      ];
    });
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}
