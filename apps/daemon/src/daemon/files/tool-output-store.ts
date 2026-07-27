import { Buffer } from 'node:buffer';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord, tryParseJson } from '../runtime-json.js';
import type { ErrorCode } from '../error-codes.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorCode } from '../utils/error.js';

const TOOL_OUTPUT_OFFLOAD_SCHEMA_VERSION = 2;

export interface ToolOutputSnapshot {
  schemaVersion: typeof TOOL_OUTPUT_OFFLOAD_SCHEMA_VERSION;
  outputRef: string;
  threadId: string;
  runId: string;
  callId: string;
  toolName: string;
  createdAt: string;
  contentType: 'json' | 'text';
  fullOutputBytes: number;
  fullOutputChars: number;
  output: string;
  source?: {
    root?: 'workspace' | 'computer';
    path?: string;
    query?: string;
    url?: string;
    finalUrl?: string;
  };
}

interface ParsedToolOutputRef {
  threadId: string;
  runId: string;
  callId: string;
}

type ToolOutputSnapshotReadErrorCode =
  | Extract<ErrorCode, 'access_denied' | 'invalid_args' | 'not_found'>
  | Extract<ErrorCode, 'internal'>;

type ToolOutputSnapshotReadResult =
  | { ok: true; value: ToolOutputSnapshot }
  | {
      ok: false;
      errorCode: ToolOutputSnapshotReadErrorCode;
      message: string;
    };

export function buildToolOutputRef(args: {
  threadId: string;
  runId: string;
  callId: string;
}): string {
  return `tool-output:${encodeRefPart(args.threadId)}/${encodeRefPart(args.runId)}/${encodeRefPart(args.callId)}`;
}

export function rebindToolOutputSnapshotThread(args: {
  snapshot: unknown;
  targetThreadId: string;
}): ToolOutputSnapshot {
  if (
    args.targetThreadId.trim() === '' ||
    !isRecord(args.snapshot) ||
    typeof args.snapshot.outputRef !== 'string'
  ) {
    throw new Error('invalid tool output snapshot transfer input');
  }
  const parsedRef = parseToolOutputRef(args.snapshot.outputRef);
  if (
    !parsedRef.ok ||
    !isToolOutputSnapshot(
      args.snapshot,
      args.snapshot.outputRef,
      parsedRef.value,
    ) ||
    args.snapshot.fullOutputBytes !==
      Buffer.byteLength(args.snapshot.output, 'utf8') ||
    args.snapshot.fullOutputChars !== args.snapshot.output.length ||
    args.snapshot.contentType !==
      (tryParseJson(args.snapshot.output).ok ? 'json' : 'text')
  ) {
    throw new Error('tool output snapshot does not match its transfer schema');
  }

  const source = normalizeToolOutputSnapshotSource(args.snapshot.source);
  if (!source.ok) {
    throw new Error('tool output snapshot source is invalid');
  }
  return {
    schemaVersion: TOOL_OUTPUT_OFFLOAD_SCHEMA_VERSION,
    outputRef: buildToolOutputRef({
      threadId: args.targetThreadId,
      runId: args.snapshot.runId,
      callId: args.snapshot.callId,
    }),
    threadId: args.targetThreadId,
    runId: args.snapshot.runId,
    callId: args.snapshot.callId,
    toolName: args.snapshot.toolName,
    createdAt: args.snapshot.createdAt,
    contentType: args.snapshot.contentType,
    fullOutputBytes: args.snapshot.fullOutputBytes,
    fullOutputChars: args.snapshot.fullOutputChars,
    output: args.snapshot.output,
    ...(source.value === undefined ? {} : { source: source.value }),
  };
}

export async function writeToolOutputSnapshot(args: {
  stateRoot: string;
  snapshot: ToolOutputSnapshot;
}): Promise<void> {
  await writeTextFileAtomically(
    buildToolOutputSnapshotPath({
      stateRoot: args.stateRoot,
      threadId: args.snapshot.threadId,
      runId: args.snapshot.runId,
      callId: args.snapshot.callId,
    }),
    JSON.stringify(args.snapshot, null, 2) + '\n',
  );
}

export async function deleteToolOutputSnapshot(args: {
  stateRoot: string;
  threadId: string;
  outputRef: string;
}): Promise<boolean> {
  const parsedRef = parseToolOutputRef(args.outputRef);
  if (!parsedRef.ok) {
    throw new Error(parsedRef.message);
  }
  if (parsedRef.value.threadId !== args.threadId) {
    throw new Error('outputRef does not belong to this thread.');
  }
  try {
    await rm(
      buildToolOutputSnapshotPath({
        stateRoot: args.stateRoot,
        threadId: parsedRef.value.threadId,
        runId: parsedRef.value.runId,
        callId: parsedRef.value.callId,
      }),
    );
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function deleteThreadToolOutputs(args: {
  stateRoot: string;
  threadId: string;
}): Promise<boolean> {
  try {
    await rm(buildThreadToolOutputDirectory(args), {
      recursive: true,
      force: false,
    });
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function pruneUnreferencedThreadToolOutputs(args: {
  stateRoot: string;
  threadId: string;
  previousOutputRefs: ReadonlySet<string>;
  retainedOutputRefs: ReadonlySet<string>;
}): Promise<number> {
  let deleted = 0;
  for (const outputRef of args.previousOutputRefs) {
    if (args.retainedOutputRefs.has(outputRef)) {
      continue;
    }
    const parsedRef = parseToolOutputRef(outputRef);
    if (!parsedRef.ok || parsedRef.value.threadId !== args.threadId) {
      continue;
    }
    const snapshotPath = buildToolOutputSnapshotPath({
      stateRoot: args.stateRoot,
      threadId: parsedRef.value.threadId,
      runId: parsedRef.value.runId,
      callId: parsedRef.value.callId,
    });
    try {
      await rm(snapshotPath, { force: false });
      deleted += 1;
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      continue;
    }
    try {
      await rmdir(dirname(snapshotPath));
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        throw error;
      }
    }
  }
  return deleted;
}

export async function readToolOutputSnapshot(args: {
  stateRoot: string;
  threadId: string;
  outputRef: string;
}): Promise<ToolOutputSnapshotReadResult> {
  const parsedRef = parseToolOutputRef(args.outputRef);
  if (!parsedRef.ok) {
    return parsedRef;
  }
  if (parsedRef.value.threadId !== args.threadId) {
    return {
      ok: false,
      errorCode: 'access_denied',
      message: 'outputRef does not belong to this thread.',
    };
  }

  const snapshotPath = buildToolOutputSnapshotPath({
    stateRoot: args.stateRoot,
    threadId: parsedRef.value.threadId,
    runId: parsedRef.value.runId,
    callId: parsedRef.value.callId,
  });
  let raw: string;
  try {
    raw = await readFile(snapshotPath, 'utf8');
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return {
        ok: false,
        errorCode: 'not_found',
        message: 'tool output snapshot was not found.',
      };
    }
    throw error;
  }

  const parsed = tryParseJson(raw);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {
      ok: false,
      errorCode: 'internal',
      message: 'tool output snapshot is not valid JSON.',
    };
  }

  if (!isToolOutputSnapshot(parsed.value, args.outputRef, parsedRef.value)) {
    return {
      ok: false,
      errorCode: 'internal',
      message: 'tool output snapshot does not match the expected schema.',
    };
  }

  return { ok: true, value: parsed.value };
}

export function buildToolOutputSnapshot(args: {
  outputRef: string;
  threadId: string;
  runId: string;
  callId: string;
  toolName: string;
  output: string;
  source?: ToolOutputSnapshot['source'];
}): ToolOutputSnapshot {
  const parsed = tryParseJson(args.output);
  return {
    schemaVersion: TOOL_OUTPUT_OFFLOAD_SCHEMA_VERSION,
    outputRef: args.outputRef,
    threadId: args.threadId,
    runId: args.runId,
    callId: args.callId,
    toolName: args.toolName,
    createdAt: new Date().toISOString(),
    contentType: parsed.ok ? 'json' : 'text',
    fullOutputBytes: Buffer.byteLength(args.output, 'utf8'),
    fullOutputChars: args.output.length,
    output: args.output,
    ...(args.source ? { source: args.source } : {}),
  };
}

function buildToolOutputSnapshotPath(args: {
  stateRoot: string;
  threadId: string;
  runId: string;
  callId: string;
}): string {
  return join(
    buildThreadToolOutputDirectory({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
    }),
    encodeRefPart(args.runId),
    `${encodeRefPart(args.callId)}.json`,
  );
}

function buildThreadToolOutputDirectory(args: {
  stateRoot: string;
  threadId: string;
}): string {
  return join(
    args.stateRoot,
    '.geulbat',
    'tool-outputs',
    encodeRefPart(args.threadId),
  );
}

function parseToolOutputRef(outputRef: string):
  | { ok: true; value: ParsedToolOutputRef }
  | {
      ok: false;
      errorCode: Extract<ErrorCode, 'invalid_args'>;
      message: string;
    } {
  const prefix = 'tool-output:';
  if (!outputRef.startsWith(prefix)) {
    return {
      ok: false,
      errorCode: 'invalid_args',
      message: 'outputRef must be a tool-output reference.',
    };
  }

  const parts = outputRef.slice(prefix.length).split('/');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return {
      ok: false,
      errorCode: 'invalid_args',
      message: 'outputRef must identify one tool output snapshot.',
    };
  }

  try {
    const [threadId, runId, callId] = parts.map((part) =>
      decodeURIComponent(part),
    );
    if (!threadId || !runId || !callId) {
      throw new Error('missing ref part');
    }
    return { ok: true, value: { threadId, runId, callId } };
  } catch {
    return {
      ok: false,
      errorCode: 'invalid_args',
      message: 'outputRef contains an invalid encoded segment.',
    };
  }
}

function encodeRefPart(value: string): string {
  return encodeURIComponent(value);
}

function isToolOutputSnapshot(
  value: unknown,
  outputRef: string,
  ref: ParsedToolOutputRef,
): value is ToolOutputSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === TOOL_OUTPUT_OFFLOAD_SCHEMA_VERSION &&
    value.outputRef === outputRef &&
    value.threadId === ref.threadId &&
    value.runId === ref.runId &&
    value.callId === ref.callId &&
    typeof value.toolName === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.contentType === 'json' || value.contentType === 'text') &&
    typeof value.fullOutputBytes === 'number' &&
    typeof value.fullOutputChars === 'number' &&
    typeof value.output === 'string'
  );
}

function normalizeToolOutputSnapshotSource(
  value: unknown,
): { ok: true; value: ToolOutputSnapshot['source'] } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    !isRecord(value) ||
    (value.root !== undefined &&
      value.root !== 'workspace' &&
      value.root !== 'computer') ||
    (value.path !== undefined && typeof value.path !== 'string') ||
    (value.query !== undefined && typeof value.query !== 'string') ||
    (value.url !== undefined && typeof value.url !== 'string') ||
    (value.finalUrl !== undefined && typeof value.finalUrl !== 'string')
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      ...(value.root === undefined ? {} : { root: value.root }),
      ...(value.path === undefined ? {} : { path: value.path }),
      ...(value.query === undefined ? {} : { query: value.query }),
      ...(value.url === undefined ? {} : { url: value.url }),
      ...(value.finalUrl === undefined ? {} : { finalUrl: value.finalUrl }),
    },
  };
}
