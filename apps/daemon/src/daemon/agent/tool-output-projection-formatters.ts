import { isRecord, tryParseJson } from '../runtime-json.js';
import type { ToolOutputSnapshot } from '../files/tool-output-store.js';
import type { ToolResultProjectionKind } from '../tools/tool-registry-model.js';

type ToolOutputFileRoot = Extract<
  NonNullable<ToolOutputSnapshot['source']>['root'],
  string
>;

interface SearchFilesSlimOutput {
  ok: true;
  offloaded: true;
  tool: string;
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  root: ToolOutputFileRoot | null;
  path: string | null;
  total: number | null;
  truncated: boolean | null;
  recoveryTool: 'read_tool_output';
  previewResults: Array<{
    path: string;
    line: number;
    text: string;
  }>;
  previewResultCount: number;
  previewHasMore: boolean;
}

interface SearchMemoryIndexSlimOutput {
  ok: true;
  offloaded: true;
  tool: string;
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  total: number | null;
  stale: boolean | null;
}

interface FetchUrlSlimOutput {
  ok: true;
  offloaded: true;
  tool: string;
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
  tool: string;
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  root: ToolOutputFileRoot | null;
  path: string | null;
  total: number | null;
  recoveryTool: 'read_tool_output';
  previewEntries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
  }>;
  previewEntryCount: number;
  previewHasMore: boolean;
}

interface ReadFileSlimOutput {
  ok: true;
  offloaded: true;
  tool: string;
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  recoveryTool: 'read_tool_output';
  root: ToolOutputFileRoot | null;
  path: string | null;
  versionToken: string | null;
  totalLines: number | null;
  pageLimit: number | null;
  startLine: number | null;
  endLine: number | null;
  hasMore: boolean | null;
  nextOffset: number | null;
}

interface RecoverableSlimOutput {
  ok: true;
  offloaded: true;
  tool: string;
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  recoveryTool: 'read_tool_output';
  kind?: string;
  status?: string;
  cellId?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  firstOutputAfterMs?: number | null;
  remediation?: string;
  outputLimitExceeded?: {
    stream: string | null;
    maxBufferedBytesPerStream: number | null;
  } | null;
}

export type ToolOutputPreviewProjection =
  | ListFilesSlimOutput
  | SearchFilesSlimOutput;

export function readToolOutputSource(
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
    const source: ToolOutputSnapshot['source'] = {};
    const query =
      readStringField(argumentsRecord, 'pattern') ??
      readStringField(outputRecord, 'query');
    if (query !== undefined) {
      source.query = query;
    }
    const root = readToolOutputFileRoot(outputRecord);
    if (root !== undefined) {
      source.root = root;
    }
    const path = readStringField(outputRecord, 'path');
    if (path !== undefined) {
      source.path = path;
    }
    return Object.keys(source).length > 0 ? source : undefined;
  }
  if (toolName === 'search_memory_index') {
    const query = readStringField(argumentsRecord, 'query');
    return query === undefined ? undefined : { query };
  }
  if (toolName === 'list_files') {
    const source: ToolOutputSnapshot['source'] = {};
    const root = readToolOutputFileRoot(outputRecord);
    if (root !== undefined) {
      source.root = root;
    }
    const path = readStringField(outputRecord, 'path');
    if (path !== undefined) {
      source.path = path;
    }
    return Object.keys(source).length > 0 ? source : undefined;
  }
  if (toolName === 'fetch_url') {
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

export function buildSlimOutput(
  snapshot: ToolOutputSnapshot,
  projection: ToolResultProjectionKind,
  fitsProjectedOutput?: (output: ToolOutputPreviewProjection) => boolean,
):
  | SearchFilesSlimOutput
  | SearchMemoryIndexSlimOutput
  | FetchUrlSlimOutput
  | ListFilesSlimOutput
  | ReadFileSlimOutput
  | RecoverableSlimOutput {
  switch (projection) {
    case 'fetch_url_summary':
      return buildFetchUrlSlimOutput(snapshot);
    case 'list_files_summary':
      return buildListFilesSlimOutput(snapshot, fitsProjectedOutput);
    case 'read_file_summary':
      return buildReadFileSlimOutput(snapshot);
    case 'runtime_summary':
      return buildRecoverableSlimOutput(snapshot);
    case 'search_memory_index_summary':
      return buildSearchMemoryIndexSlimOutput(snapshot);
    case 'search_files_summary':
      return buildSearchFilesSlimOutput(snapshot, fitsProjectedOutput);
  }
}

function readStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readToolOutputFileRoot(
  record: Record<string, unknown> | null,
): ToolOutputFileRoot | undefined {
  const value = record?.['root'];
  return value === 'workspace' || value === 'computer' ? value : undefined;
}

function buildRecoverableSlimOutput(
  snapshot: ToolOutputSnapshot,
): RecoverableSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const kind = readStringField(record, 'kind');
  const status = readStringField(record, 'status');
  const cellId = readStringField(record, 'cellId');
  const remediation = readStringField(record, 'remediation');
  const exitCode = readNullableNumberField(record, 'exitCode');
  const durationMs = readNullableNumberField(record, 'durationMs');
  const firstOutputAfterMs = readNullableNumberField(
    record,
    'firstOutputAfterMs',
  );
  const outputLimitExceeded = readOutputLimitExceeded(record);

  return {
    ok: true,
    offloaded: true,
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildRecoverableSummary(snapshot.toolName, record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    recoveryTool: 'read_tool_output',
    ...(kind === undefined ? {} : { kind }),
    ...(status === undefined ? {} : { status }),
    ...(cellId === undefined ? {} : { cellId }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(firstOutputAfterMs === undefined ? {} : { firstOutputAfterMs }),
    ...(remediation === undefined ? {} : { remediation }),
    ...(outputLimitExceeded === undefined ? {} : { outputLimitExceeded }),
  };
}

function readNullableNumberField(
  record: Record<string, unknown> | null,
  key: string,
): number | null | undefined {
  const value = record?.[key];
  return value === null || typeof value === 'number' ? value : undefined;
}

function readOutputLimitExceeded(
  record: Record<string, unknown> | null,
): RecoverableSlimOutput['outputLimitExceeded'] | undefined {
  const value = record?.['outputLimitExceeded'];
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    stream: readStringField(value, 'stream') ?? null,
    maxBufferedBytesPerStream:
      typeof value.maxBufferedBytesPerStream === 'number'
        ? value.maxBufferedBytesPerStream
        : null,
  };
}

function buildRecoverableSummary(
  tool: string,
  record: Record<string, unknown> | null,
): string {
  const status = readStringField(record, 'status');
  const cellId = readStringField(record, 'cellId');
  const exitCode = readNullableNumberField(record, 'exitCode');
  const exactRecovery =
    'Exact output is available through read_tool_output with explicit offset and limit.';
  if (tool === 'exec' && cellId !== undefined && status !== undefined) {
    return `exec is ${status} in cell ${cellId}. ${exactRecovery}`;
  }
  if (tool === 'wait' && cellId !== undefined && status !== undefined) {
    return `wait observed cell ${cellId} with status ${status}${formatExitCode(exitCode)}. ${exactRecovery}`;
  }
  if (tool === 'exec_command' && status !== undefined) {
    return `exec_command finished with status ${status}${formatExitCode(exitCode)}. ${exactRecovery}`;
  }
  const completed = record?.['completed'];
  const pending = record?.['pending'];
  const blocked = record?.['blocked'];
  const launches = record?.['launches'];
  if (
    tool === 'agent_wait' &&
    Array.isArray(completed) &&
    Array.isArray(pending) &&
    Array.isArray(blocked)
  ) {
    const launchSummary = Array.isArray(launches)
      ? ` Durable launch status covers ${launches.length} handles, including ${launches.filter((launch) => isRecord(launch) && launch.launchState === 'queued').length} queued and ${launches.filter((launch) => isRecord(launch) && launch.launchState === 'starting').length} starting.`
      : '';
    return `agent_wait returned ${completed.length} completed, ${pending.length} pending, and ${blocked.length} blocked child runs.${launchSummary} ${exactRecovery}`;
  }
  return `${tool} returned a durable output snapshot. ${exactRecovery}`;
}

function formatExitCode(exitCode: number | null | undefined): string {
  return typeof exitCode === 'number'
    ? ` and exit code ${String(exitCode)}`
    : '';
}

function buildSearchFilesSlimOutput(
  snapshot: ToolOutputSnapshot,
  fitsProjectedOutput?: (output: ToolOutputPreviewProjection) => boolean,
): SearchFilesSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const results = record?.['results'];
  const total =
    record && typeof record.total === 'number' ? record.total : null;
  const buildOutput = (
    previewResults: SearchFilesSlimOutput['previewResults'],
  ): SearchFilesSlimOutput => ({
    ok: true,
    offloaded: true,
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildSearchFilesSummary(record, previewResults.length),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    root: readToolOutputFileRoot(record) ?? null,
    path: readStringField(record, 'path') ?? null,
    total,
    truncated:
      record && typeof record.truncated === 'boolean' ? record.truncated : null,
    recoveryTool: 'read_tool_output',
    previewResults,
    previewResultCount: previewResults.length,
    previewHasMore:
      Array.isArray(results) && results.length > previewResults.length,
  });
  const emptyOutput = buildOutput([]);
  if (fitsProjectedOutput === undefined || !Array.isArray(results)) {
    return emptyOutput;
  }

  let previewResults: SearchFilesSlimOutput['previewResults'] = [];
  for (const result of results) {
    const previewResult = readSearchFilesPreviewResult(result);
    if (previewResult === null) {
      break;
    }
    const candidateResults = [...previewResults, previewResult];
    const candidate = buildOutput(candidateResults);
    if (!fitsProjectedOutput(candidate)) {
      break;
    }
    previewResults = candidateResults;
  }
  return previewResults.length === 0
    ? emptyOutput
    : buildOutput(previewResults);
}

function readSearchFilesPreviewResult(
  result: unknown,
): SearchFilesSlimOutput['previewResults'][number] | null {
  if (!isRecord(result)) {
    return null;
  }
  const path = result['path'];
  const line = result['line'];
  const text = result['text'];
  if (
    typeof path !== 'string' ||
    typeof line !== 'number' ||
    !Number.isSafeInteger(line) ||
    line < 0 ||
    typeof text !== 'string'
  ) {
    return null;
  }
  return { path, line, text };
}

function buildSearchMemoryIndexSlimOutput(
  snapshot: ToolOutputSnapshot,
): SearchMemoryIndexSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  return {
    ok: true,
    offloaded: true,
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildSearchMemoryIndexSummary(record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    total: record && typeof record.total === 'number' ? record.total : null,
    stale: record && typeof record.stale === 'boolean' ? record.stale : null,
  };
}

function buildFetchUrlSlimOutput(
  snapshot: ToolOutputSnapshot,
): FetchUrlSlimOutput {
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
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildFetchUrlSummary(record),
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
  fitsProjectedOutput?: (output: ToolOutputPreviewProjection) => boolean,
): ListFilesSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const entries = record?.['entries'];
  const total =
    record && typeof record.total === 'number' ? record.total : null;
  const buildOutput = (
    previewEntries: ListFilesSlimOutput['previewEntries'],
  ): ListFilesSlimOutput => ({
    ok: true,
    offloaded: true,
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildListFilesSummary(record, previewEntries.length),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    root: readToolOutputFileRoot(record) ?? null,
    path: record && typeof record.path === 'string' ? record.path : null,
    total,
    recoveryTool: 'read_tool_output',
    previewEntries,
    previewEntryCount: previewEntries.length,
    previewHasMore:
      total === null
        ? Array.isArray(entries) && entries.length > previewEntries.length
        : total > previewEntries.length,
  });
  const emptyOutput = buildOutput([]);
  if (fitsProjectedOutput === undefined || !Array.isArray(entries)) {
    return emptyOutput;
  }

  let previewEntries: ListFilesSlimOutput['previewEntries'] = [];
  for (const entry of entries) {
    const previewEntry = readListFilesPreviewEntry(entry);
    if (previewEntry === null) {
      break;
    }
    const candidateEntries = [...previewEntries, previewEntry];
    const candidate = buildOutput(candidateEntries);
    if (!fitsProjectedOutput(candidate)) {
      break;
    }
    previewEntries = candidateEntries;
  }
  return previewEntries.length === 0
    ? emptyOutput
    : buildOutput(previewEntries);
}

function readListFilesPreviewEntry(
  entry: unknown,
): ListFilesSlimOutput['previewEntries'][number] | null {
  if (!isRecord(entry)) {
    return null;
  }
  const name = entry['name'];
  const path = entry['path'];
  const type = entry['type'];
  if (
    typeof name !== 'string' ||
    typeof path !== 'string' ||
    (type !== 'file' && type !== 'directory')
  ) {
    return null;
  }
  return { name, path, type };
}

function buildReadFileSlimOutput(
  snapshot: ToolOutputSnapshot,
): ReadFileSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const hasMore = record?.['hasMore'];
  return {
    ok: true,
    offloaded: true,
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildReadFileSummary(record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    recoveryTool: 'read_tool_output',
    root: readToolOutputFileRoot(record) ?? null,
    path: readStringField(record, 'path') ?? null,
    versionToken: readStringField(record, 'versionToken') ?? null,
    totalLines: readNullableNumberField(record, 'totalLines') ?? null,
    pageLimit: readNullableNumberField(record, 'pageLimit') ?? null,
    startLine: readNullableNumberField(record, 'startLine') ?? null,
    endLine: readNullableNumberField(record, 'endLine') ?? null,
    hasMore: typeof hasMore === 'boolean' ? hasMore : null,
    nextOffset: readNullableNumberField(record, 'nextOffset') ?? null,
  };
}

function buildReadFileSummary(record: Record<string, unknown> | null): string {
  const path = readStringField(record, 'path') ?? 'the requested path';
  const totalLines = readNullableNumberField(record, 'totalLines');
  const startLine = readNullableNumberField(record, 'startLine');
  const endLine = readNullableNumberField(record, 'endLine');
  const nextOffset = readNullableNumberField(record, 'nextOffset');
  const hasMore = record?.['hasMore'];
  const pageDescription =
    typeof totalLines === 'number' &&
    typeof startLine === 'number' &&
    typeof endLine === 'number'
      ? `lines ${startLine}-${endLine} of ${totalLines}`
      : 'a bounded page';
  const continuation =
    hasMore === true && typeof nextOffset === 'number'
      ? ` The source has more lines at nextOffset ${nextOffset}.`
      : '';
  return `read_file returned ${pageDescription} for ${path}. Exact page output is available through read_tool_output with explicit offset and limit.${continuation}`;
}

function buildListFilesSummary(
  record: Record<string, unknown> | null,
  previewEntryCount: number,
): string {
  if (!record) {
    return 'list_files returned a large listing. Full output was written to the tool output snapshot.';
  }
  const path =
    typeof record.path === 'string' ? record.path : 'an unknown path';
  const total =
    typeof record.total === 'number'
      ? `${record.total} ${record.total === 1 ? 'entry' : 'entries'}`
      : 'a large listing';
  const preview =
    previewEntryCount > 0
      ? ` The first ${previewEntryCount} ${previewEntryCount === 1 ? 'entry is' : 'entries are'} included in previewEntries.`
      : '';
  return `list_files returned ${total} for ${path}.${preview} Full output was written to the tool output snapshot.`;
}

function buildFetchUrlSummary(record: Record<string, unknown> | null): string {
  if (!record) {
    return 'fetch_url returned a large response. Full output was written to the tool output snapshot.';
  }
  const finalUrl =
    typeof record.finalUrl === 'string' ? record.finalUrl : 'an unknown URL';
  const title =
    typeof record.title === 'string' ? ` titled "${record.title}"` : '';
  return `fetch_url returned a large response from ${finalUrl}${title}. Full output was written to the tool output snapshot.`;
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

function buildSearchFilesSummary(
  value: unknown,
  previewResultCount: number,
): string {
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
  const previewLabel =
    previewResultCount > 0
      ? ` The first ${previewResultCount} ${previewResultCount === 1 ? 'result is' : 'results are'} included in previewResults.`
      : '';
  return `search_files returned ${countLabel}.${truncatedLabel}${recordedLabel}${previewLabel} Full output was written to the tool output snapshot.`;
}
