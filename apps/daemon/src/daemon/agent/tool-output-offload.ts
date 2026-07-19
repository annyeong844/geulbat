import { isRecord, tryParseJson } from '../runtime-json.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { FunctionCall } from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import type { ExecuteResult } from '../tools/types.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  type ToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import {
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';

const logger = createLogger('tool-output-offload');

const TOOL_OUTPUT_INLINE_MAX_BYTES_ENV = 'GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES';
const DEFAULT_TOOL_OUTPUT_INLINE_MAX_BYTES = 40 * 1024;

interface ToolOutputProjectionPolicy {
  inlineMaxBytes: number;
}

type ToolOutputProjectionPolicyEnv = Partial<
  Record<typeof TOOL_OUTPUT_INLINE_MAX_BYTES_ENV, string>
>;

export function resolveToolOutputProjectionPolicyFromEnv(
  env: ToolOutputProjectionPolicyEnv = process.env,
): ToolOutputProjectionPolicy {
  return {
    inlineMaxBytes: readPositiveIntegerEnv(
      env,
      TOOL_OUTPUT_INLINE_MAX_BYTES_ENV,
      DEFAULT_TOOL_OUTPUT_INLINE_MAX_BYTES,
    ),
  };
}

const PROCESS_TOOL_OUTPUT_PROJECTION_POLICY =
  resolveToolOutputProjectionPolicyFromEnv();

interface ToolOutputOffloadArgs {
  functionCall: Pick<FunctionCall, 'callId' | 'name' | 'arguments'>;
  runContext: Pick<RunContext, 'threadId' | 'stateRoot'>;
  runId: string;
  projectionPolicy?: ToolOutputProjectionPolicy;
  toolOutputRecoveryAvailable?: boolean;
  toolResult: ExecuteResult;
}

type ToolOutputFileRoot = Extract<
  NonNullable<ToolOutputSnapshot['source']>['root'],
  string
>;

interface SearchFilesSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'search_files';
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  root: ToolOutputFileRoot | null;
  path: string | null;
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

interface FetchUrlSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'fetch_url';
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
  root: ToolOutputFileRoot | null;
  path: string | null;
  total: number | null;
}

interface RecoverableSlimOutput {
  ok: true;
  offloaded: true;
  tool: 'exec' | 'wait' | 'exec_command';
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
  remediation?: string;
  outputLimitExceeded?: {
    stream: string | null;
    maxBufferedBytesPerStream: number | null;
  } | null;
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
  const wantsRecoverableOffload = shouldOffloadRecoverableToolOutput(
    functionCall.name,
  );
  const shouldOffload = wantsOffload && recoveryAvailable;
  const shouldOffloadRecoverable = wantsRecoverableOffload && recoveryAvailable;
  if (!shouldOffload && !shouldOffloadRecoverable) {
    return toolResult;
  }

  const parsedOutput = tryParseJson(toolResult.output);
  if (
    hasExistingWaitRecoveryRef({
      toolName: functionCall.name,
      parsedOutput,
      threadId: runContext.threadId,
    })
  ) {
    return toolResult;
  }

  const projectionPolicy =
    args.projectionPolicy ?? PROCESS_TOOL_OUTPUT_PROJECTION_POLICY;
  if (
    Buffer.byteLength(toolResult.output, 'utf8') <=
    projectionPolicy.inlineMaxBytes
  ) {
    return toolResult;
  }

  const outputRef = buildToolOutputRef({
    callId: functionCall.callId,
    runId,
    threadId: runContext.threadId,
  });
  const parsedArguments = tryParseJson(functionCall.arguments);
  const source = readToolOutputSource(
    functionCall.name,
    parsedOutput,
    parsedArguments,
  );
  const snapshot = buildToolOutputSnapshot({
    outputRef,
    threadId: runContext.threadId,
    runId,
    callId: functionCall.callId,
    toolName: functionCall.name,
    output: toolResult.output,
    ...(source ? { source } : {}),
  });

  try {
    await writeToolOutputSnapshot({
      stateRoot: runContext.stateRoot,
      snapshot,
    });
  } catch {
    logger.warn('failed to offload tool output snapshot:', {
      callId: functionCall.callId,
      runId,
      threadId: runContext.threadId,
      toolName: functionCall.name,
    });
    if (shouldOffloadRecoverableToolOutput(functionCall.name)) {
      return {
        ok: true,
        output: buildRecoverableInlineFallback(
          toolResult.output,
          functionCall.name,
        ),
      };
    }
    return {
      ok: false,
      output: '',
      errorCode: 'internal',
      error:
        'failed to offload tool output snapshot; full output was not recorded.',
    };
  }

  return {
    ok: true,
    output: JSON.stringify(buildSlimOutput(snapshot)),
  };
}

function readPositiveIntegerEnv(
  env: ToolOutputProjectionPolicyEnv,
  name: keyof ToolOutputProjectionPolicyEnv,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`invalid ${name}: empty`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  return parsed;
}

function buildRecoverableInlineFallback(
  output: string,
  tool: RecoverableSlimOutput['tool'],
): string {
  const parsed = tryParseJson(output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;

  return JSON.stringify({
    ...(record ?? { output }),
    offloaded: false,
    tool,
    outputSnapshot: {
      ok: false,
      errorCode: 'snapshot_write_failed',
    },
    recoveryTool: null,
    summary:
      'Durable output snapshot failed; the exact tool result is retained inline for this history entry.',
  });
}

function shouldOffloadToolOutput(toolName: string): boolean {
  return (
    toolName === 'search_files' ||
    toolName === 'search_memory_index' ||
    toolName === 'fetch_url' ||
    toolName === 'list_files'
  );
}

function shouldOffloadRecoverableToolOutput(
  toolName: string,
): toolName is RecoverableSlimOutput['tool'] {
  return (
    toolName === 'exec' || toolName === 'wait' || toolName === 'exec_command'
  );
}

function hasExistingWaitRecoveryRef(args: {
  toolName: string;
  parsedOutput: ReturnType<typeof tryParseJson>;
  threadId: string;
}): boolean {
  if (
    args.toolName !== 'wait' ||
    !args.parsedOutput.ok ||
    !isRecord(args.parsedOutput.value)
  ) {
    return false;
  }
  const output = args.parsedOutput.value;
  if (typeof output.cellId !== 'string') {
    return false;
  }
  const expectedOutputRef = buildToolOutputRef({
    threadId: args.threadId,
    runId: PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
    callId: output.cellId,
  });
  return (
    output.kind === 'ptc_execute_code_cell_wait' &&
    output.capabilityId === PTC_EXECUTE_CODE_TOOL_NAME &&
    output.policyId === PTC_EXECUTE_CODE_POLICY_ID &&
    output.executionSurface === 'node_via_lab_detached_cell' &&
    (output.status === 'completed' ||
      output.status === 'terminated' ||
      output.status === 'completed_with_cleanup_failure' ||
      output.status === 'terminated_with_cleanup_failure') &&
    (output.exitCode === null ||
      (typeof output.exitCode === 'number' &&
        Number.isSafeInteger(output.exitCode))) &&
    output.offloaded === true &&
    output.recoveryTool === 'read_tool_output' &&
    output.outputRef === expectedOutputRef &&
    typeof output.fullOutputBytes === 'number' &&
    Number.isSafeInteger(output.fullOutputBytes) &&
    output.fullOutputBytes >= 0 &&
    typeof output.fullOutputChars === 'number' &&
    Number.isSafeInteger(output.fullOutputChars) &&
    output.fullOutputChars >= 0
  );
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

function buildSlimOutput(
  snapshot: ToolOutputSnapshot,
):
  | SearchFilesSlimOutput
  | SearchMemoryIndexSlimOutput
  | FetchUrlSlimOutput
  | ListFilesSlimOutput
  | RecoverableSlimOutput {
  if (shouldOffloadRecoverableToolOutput(snapshot.toolName)) {
    return buildRecoverableSlimOutput(snapshot, snapshot.toolName);
  }
  if (snapshot.toolName === 'fetch_url') {
    return buildFetchUrlSlimOutput(snapshot);
  }
  if (snapshot.toolName === 'list_files') {
    return buildListFilesSlimOutput(snapshot);
  }
  if (snapshot.toolName === 'search_memory_index') {
    return buildSearchMemoryIndexSlimOutput(snapshot);
  }
  return buildSearchFilesSlimOutput(snapshot);
}

function buildRecoverableSlimOutput(
  snapshot: ToolOutputSnapshot,
  tool: RecoverableSlimOutput['tool'],
): RecoverableSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  const kind = readStringField(record, 'kind');
  const status = readStringField(record, 'status');
  const cellId = readStringField(record, 'cellId');
  const remediation = readStringField(record, 'remediation');
  const exitCode = readNullableNumberField(record, 'exitCode');
  const outputLimitExceeded = readOutputLimitExceeded(record);

  return {
    ok: true,
    offloaded: true,
    tool,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildRecoverableSummary(tool, record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    recoveryTool: 'read_tool_output',
    ...(kind === undefined ? {} : { kind }),
    ...(status === undefined ? {} : { status }),
    ...(cellId === undefined ? {} : { cellId }),
    ...(exitCode === undefined ? {} : { exitCode }),
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
  tool: RecoverableSlimOutput['tool'],
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
  return `${tool} returned a durable output snapshot. ${exactRecovery}`;
}

function formatExitCode(exitCode: number | null | undefined): string {
  return typeof exitCode === 'number'
    ? ` and exit code ${String(exitCode)}`
    : '';
}

function buildSearchFilesSlimOutput(
  snapshot: ToolOutputSnapshot,
): SearchFilesSlimOutput {
  const parsed = tryParseJson(snapshot.output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  return {
    ok: true,
    offloaded: true,
    tool: 'search_files',
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    summary: buildSearchFilesSummary(record),
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
    root: readToolOutputFileRoot(record) ?? null,
    path: readStringField(record, 'path') ?? null,
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
    tool: 'fetch_url',
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
    root: readToolOutputFileRoot(record) ?? null,
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
