import {
  TOOL_SDK_PUBLIC_TOOLS,
  type ToolSdkFailure,
  type ToolSdkJsonValue,
  type ToolSdkPublicTool,
  type ToolSdkResult,
} from '@geulbat/tool-sdk';
import { isRecord, tryParseJsonRecord } from '../runtime-json.js';

export type DaemonToolSdkPublicInlineResult = ToolSdkResult<{
  kind: 'inline';
  value: ToolSdkJsonValue;
}>;

export interface DaemonToolSdkPublicBinding {
  internalTool: string;
  normalizeResult(
    output: string,
    input?: Readonly<Record<string, ToolSdkJsonValue>>,
  ): DaemonToolSdkPublicInlineResult;
}

export const DAEMON_TOOL_SDK_PUBLIC_BINDINGS = {
  'files.read': {
    internalTool: 'read_file',
    normalizeResult: normalizeReadFileResult,
  },
  'files.list': {
    internalTool: 'list_files',
    normalizeResult: normalizeListFilesResult,
  },
  'files.search': {
    internalTool: 'search_files',
    normalizeResult: normalizeSearchFilesResult,
  },
} satisfies Record<ToolSdkPublicTool, DaemonToolSdkPublicBinding>;

export function readDaemonToolSdkPublicBindingForInternalTool(
  toolName: string,
): {
  publicTool: ToolSdkPublicTool;
  binding: DaemonToolSdkPublicBinding;
} | null {
  for (const publicTool of TOOL_SDK_PUBLIC_TOOLS) {
    const binding = DAEMON_TOOL_SDK_PUBLIC_BINDINGS[publicTool];
    if (binding.internalTool === toolName) {
      return { publicTool, binding };
    }
  }
  return null;
}

function normalizeReadFileResult(
  output: string,
  input?: Readonly<Record<string, ToolSdkJsonValue>>,
): DaemonToolSdkPublicInlineResult {
  const parsed = readToolResultObject(output);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const path = value['path'];
  const content = value['content'];
  const versionToken = value['versionToken'];
  const totalLines = value['totalLines'];
  const pageLimit = value['pageLimit'];
  const startLine = value['startLine'];
  const endLine = value['endLine'];
  const hasMore = value['hasMore'];
  const nextOffset = value['nextOffset'];
  const requestedLimit = input?.['limit'];
  if (
    typeof path !== 'string' ||
    typeof content !== 'string' ||
    typeof versionToken !== 'string' ||
    !isNonNegativeSafeInteger(totalLines) ||
    !isPositiveSafeInteger(pageLimit) ||
    (requestedLimit !== undefined &&
      (!isPositiveSafeInteger(requestedLimit) ||
        pageLimit !== requestedLimit)) ||
    !isPositiveSafeInteger(startLine) ||
    !isNonNegativeSafeInteger(endLine) ||
    typeof hasMore !== 'boolean' ||
    (nextOffset !== null && !isNonNegativeSafeInteger(nextOffset)) ||
    (hasMore && nextOffset === null) ||
    (!hasMore && nextOffset !== null)
  ) {
    return invalidToolResult();
  }
  return {
    ok: true,
    value: {
      kind: 'inline',
      value: {
        path,
        content,
        versionToken,
        totalLines,
        pageLimit,
        startLine,
        endLine,
        hasMore,
        nextOffset,
      },
    },
  };
}

function normalizeListFilesResult(
  output: string,
): DaemonToolSdkPublicInlineResult {
  const parsed = readToolResultObject(output);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const path = value['path'];
  const total = value['total'];
  const rawEntries = value['entries'];
  if (
    typeof path !== 'string' ||
    !isNonNegativeSafeInteger(total) ||
    !Array.isArray(rawEntries) ||
    rawEntries.length !== total
  ) {
    return invalidToolResult();
  }
  const entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
  }> = [];
  for (const rawEntry of rawEntries) {
    if (!isRecord(rawEntry)) {
      return invalidToolResult();
    }
    const name = rawEntry['name'];
    const entryPath = rawEntry['path'];
    const type = rawEntry['type'];
    if (
      typeof name !== 'string' ||
      typeof entryPath !== 'string' ||
      (type !== 'file' && type !== 'directory')
    ) {
      return invalidToolResult();
    }
    entries.push({ name, path: entryPath, type });
  }
  return {
    ok: true,
    value: {
      kind: 'inline',
      value: { path, total, entries },
    },
  };
}

function normalizeSearchFilesResult(
  output: string,
  input?: Readonly<Record<string, ToolSdkJsonValue>>,
): DaemonToolSdkPublicInlineResult {
  const parsed = readToolResultObject(output);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const path = value['path'];
  const type =
    input === undefined ? value['type'] : (input['type'] ?? 'content');
  const consistency =
    input === undefined
      ? value['consistency']
      : (input['consistency'] ?? 'filesystem_snapshot');
  const total = value['total'];
  const totalRelation =
    input !== undefined && consistency === 'filesystem_snapshot'
      ? 'exact'
      : value['totalRelation'];
  const truncated = value['truncated'];
  const rawResults = value['results'];
  const maxResults = input?.['maxResults'];
  if (
    typeof path !== 'string' ||
    (type !== 'content' && type !== 'filename') ||
    (consistency !== 'filesystem_snapshot' &&
      consistency !== 'eventual_index') ||
    !isNonNegativeSafeInteger(total) ||
    (totalRelation !== 'exact' && totalRelation !== 'lower_bound') ||
    typeof truncated !== 'boolean' ||
    !Array.isArray(rawResults) ||
    rawResults.length > total ||
    (maxResults !== undefined &&
      (!isPositiveSafeInteger(maxResults) || rawResults.length > maxResults)) ||
    (input !== undefined && truncated && maxResults === undefined) ||
    (consistency === 'filesystem_snapshot' && totalRelation !== 'exact') ||
    (consistency === 'eventual_index' && type !== 'filename') ||
    (input !== undefined &&
      consistency === 'eventual_index' &&
      value['consistency'] !== 'eventual_index') ||
    (totalRelation === 'lower_bound' &&
      (consistency !== 'eventual_index' || !truncated)) ||
    (!truncated && rawResults.length !== total) ||
    (truncated && totalRelation === 'exact' && rawResults.length >= total) ||
    (truncated &&
      totalRelation === 'lower_bound' &&
      rawResults.length !== total)
  ) {
    return invalidToolResult();
  }

  const results: Array<{ path: string; line: number; text: string }> = [];
  for (const rawResult of rawResults) {
    if (!isRecord(rawResult)) {
      return invalidToolResult();
    }
    const resultPath = rawResult['path'];
    const line = rawResult['line'];
    const text = rawResult['text'];
    if (
      typeof resultPath !== 'string' ||
      !isNonNegativeSafeInteger(line) ||
      typeof text !== 'string' ||
      (type === 'filename' && (line !== 0 || text.length !== 0)) ||
      (type === 'content' && line === 0)
    ) {
      return invalidToolResult();
    }
    results.push({ path: resultPath, line, text });
  }
  return {
    ok: true,
    value: {
      kind: 'inline',
      value: {
        path,
        type,
        consistency,
        total,
        totalRelation,
        truncated,
        results,
      },
    },
  };
}

function readToolResultObject(
  output: string,
): ToolSdkResult<Record<string, unknown>> {
  const parsed = tryParseJsonRecord(output);
  return parsed.ok ? parsed : invalidToolResult();
}

function invalidToolResult(): ToolSdkFailure {
  return {
    ok: false,
    error: {
      code: 'invalid_transport_response',
      message: 'The daemon tool returned an invalid public result',
      retryable: false,
    },
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}
