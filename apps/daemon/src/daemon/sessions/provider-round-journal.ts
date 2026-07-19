import { appendFile, chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertRunId,
  assertThreadId,
  isRunId,
  isThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  isProviderAuthProviderId,
  isProviderReplayScopeId,
  type ProviderAuthProviderId,
  type ProviderReplayScopeId,
} from '@geulbat/protocol/provider-auth';

import { isJsonValue, isRecord, type JsonValue } from '../runtime-json.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';

const PROVIDER_ROUND_JOURNAL_SCHEMA_VERSION = 2;
const runProviderRoundAppendSerial = createKeyedSerialRunner();

export interface ProviderRoundJournalRecord {
  schemaVersion: typeof PROVIDER_ROUND_JOURNAL_SCHEMA_VERSION;
  threadId: ThreadId;
  runId: RunId;
  round: number;
  providerId: ProviderAuthProviderId;
  model: string;
  replayScopeId: ProviderReplayScopeId | null;
  precedingTranscriptEntryId: string | null;
  items: JsonValue[];
  functionCalls: ProviderRoundJournalFunctionCall[];
  createdAt: string;
}

interface ProviderRoundJournalFunctionCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  replaySafe: boolean;
}

export async function appendProviderRound(args: {
  stateRoot: string;
  threadId: ThreadId;
  runId: RunId;
  round: number;
  providerId: ProviderAuthProviderId;
  model: string;
  replayScopeId: ProviderReplayScopeId | null;
  precedingTranscriptEntryId: string | null;
  items: readonly unknown[];
  functionCalls: readonly ProviderRoundJournalFunctionCall[];
  now?: () => string;
}): Promise<ProviderRoundJournalRecord> {
  if (!Number.isSafeInteger(args.round) || args.round < 0) {
    throw new Error('invalid provider round journal round');
  }
  const model = args.model.trim();
  if (model === '') {
    throw new Error('invalid provider round journal model');
  }
  if (
    args.replayScopeId !== null &&
    !isProviderReplayScopeId(args.replayScopeId)
  ) {
    throw new Error('invalid provider round replay scope');
  }
  if (
    args.precedingTranscriptEntryId !== null &&
    args.precedingTranscriptEntryId.trim() === ''
  ) {
    throw new Error('invalid provider round transcript anchor');
  }
  const items = args.items.map((item) => {
    if (!isRecord(item) || !isJsonValue(item)) {
      throw new Error('provider round journal requires raw provider items');
    }
    return item;
  });
  if (items.length === 0) {
    throw new Error('provider round journal requires at least one item');
  }
  const functionCalls = args.functionCalls.map((call) => ({ ...call }));
  if (
    functionCalls.some(
      (call) =>
        call.id.trim() === '' ||
        call.callId.trim() === '' ||
        call.name.trim() === '' ||
        call.arguments.trim() === '' ||
        !isProviderRoundJournalFunctionCall(call),
    ) ||
    !providerFunctionCallsMatch(items, functionCalls)
  ) {
    throw new Error('provider round journal function calls do not match items');
  }

  const record: ProviderRoundJournalRecord = {
    schemaVersion: PROVIDER_ROUND_JOURNAL_SCHEMA_VERSION,
    threadId: assertThreadId(args.threadId),
    runId: assertRunId(args.runId),
    round: args.round,
    providerId: args.providerId,
    model,
    replayScopeId: args.replayScopeId,
    precedingTranscriptEntryId: args.precedingTranscriptEntryId,
    items,
    functionCalls,
    createdAt: (args.now ?? (() => new Date().toISOString()))(),
  };
  const path = providerRoundJournalPath(args.stateRoot, args.threadId);
  await runProviderRoundAppendSerial(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(path, 0o600);
  });
  return record;
}

export async function readProviderRoundHistory(
  stateRoot: string,
  threadId: ThreadId,
): Promise<ProviderRoundJournalRecord[]> {
  const path = providerRoundJournalPath(stateRoot, threadId);
  let body: string;
  try {
    body = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return body
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseProviderRoundJournalRecord(JSON.parse(line), threadId));
}

export async function copyProviderRoundHistory(args: {
  stateRoot: string;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  retainedTranscriptEntryIds: ReadonlySet<string>;
}): Promise<number> {
  const records = await readProviderRoundHistory(
    args.stateRoot,
    args.sourceThreadId,
  );
  let copied = 0;
  for (const record of records) {
    if (
      record.precedingTranscriptEntryId !== null &&
      !args.retainedTranscriptEntryIds.has(record.precedingTranscriptEntryId)
    ) {
      continue;
    }
    await appendProviderRound({
      stateRoot: args.stateRoot,
      threadId: args.targetThreadId,
      runId: record.runId,
      round: record.round,
      providerId: record.providerId,
      model: record.model,
      replayScopeId: record.replayScopeId,
      precedingTranscriptEntryId: record.precedingTranscriptEntryId,
      items: record.items,
      functionCalls: record.functionCalls,
      now: () => record.createdAt,
    });
    copied += 1;
  }
  return copied;
}

export async function deleteProviderRoundHistory(
  stateRoot: string,
  threadId: ThreadId,
): Promise<boolean> {
  try {
    await unlink(providerRoundJournalPath(stateRoot, threadId));
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export function providerRoundJournalPath(
  stateRoot: string,
  threadId: ThreadId,
): string {
  return join(
    stateRoot,
    '.geulbat',
    'provider-rounds',
    `${assertThreadId(threadId)}.jsonl`,
  );
}

function parseProviderRoundJournalRecord(
  value: unknown,
  expectedThreadId: ThreadId,
): ProviderRoundJournalRecord {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== PROVIDER_ROUND_JOURNAL_SCHEMA_VERSION) ||
    typeof value.threadId !== 'string' ||
    !isThreadId(value.threadId) ||
    value.threadId !== expectedThreadId ||
    typeof value.runId !== 'string' ||
    !isRunId(value.runId) ||
    typeof value.round !== 'number' ||
    !Number.isSafeInteger(value.round) ||
    value.round < 0 ||
    !isProviderAuthProviderId(value.providerId) ||
    typeof value.model !== 'string' ||
    value.model.trim() === '' ||
    (value.schemaVersion === PROVIDER_ROUND_JOURNAL_SCHEMA_VERSION &&
      value.replayScopeId !== null &&
      !isProviderReplayScopeId(value.replayScopeId)) ||
    (value.precedingTranscriptEntryId !== null &&
      (typeof value.precedingTranscriptEntryId !== 'string' ||
        value.precedingTranscriptEntryId.trim() === '')) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    !value.items.every((item) => isRecord(item) && isJsonValue(item)) ||
    !Array.isArray(value.functionCalls) ||
    !value.functionCalls.every(isProviderRoundJournalFunctionCall) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('invalid provider round journal record');
  }
  if (!providerFunctionCallsMatch(value.items, value.functionCalls)) {
    throw new Error('provider round journal function calls do not match items');
  }
  return {
    schemaVersion: PROVIDER_ROUND_JOURNAL_SCHEMA_VERSION,
    threadId: assertThreadId(value.threadId),
    runId: assertRunId(value.runId),
    round: value.round,
    providerId: value.providerId,
    model: value.model,
    replayScopeId:
      value.schemaVersion === 1
        ? null
        : (value.replayScopeId as ProviderReplayScopeId | null),
    precedingTranscriptEntryId: value.precedingTranscriptEntryId,
    items: value.items,
    functionCalls: value.functionCalls,
    createdAt: value.createdAt,
  };
}

function providerFunctionCallsMatch(
  items: readonly JsonValue[],
  functionCalls: readonly ProviderRoundJournalFunctionCall[],
): boolean {
  const rawCalls = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    if (item['type'] !== 'function_call') {
      continue;
    }
    const id = item['id'];
    const callId = item['call_id'];
    const name = item['name'];
    const callArguments = item['arguments'];
    if (
      typeof id !== 'string' ||
      typeof callId !== 'string' ||
      typeof name !== 'string' ||
      typeof callArguments !== 'string' ||
      rawCalls.has(callId)
    ) {
      return false;
    }
    rawCalls.set(callId, { id, name, arguments: callArguments });
  }
  if (rawCalls.size !== functionCalls.length) {
    return false;
  }
  return functionCalls.every((call) => {
    const raw = rawCalls.get(call.callId);
    return (
      raw !== undefined &&
      raw.id === call.id &&
      raw.name === call.name &&
      raw.arguments === call.arguments
    );
  });
}

function isProviderRoundJournalFunctionCall(
  value: unknown,
): value is ProviderRoundJournalFunctionCall {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim() !== '' &&
    typeof value.callId === 'string' &&
    value.callId.trim() !== '' &&
    typeof value.name === 'string' &&
    value.name.trim() !== '' &&
    typeof value.arguments === 'string' &&
    value.arguments.trim() !== '' &&
    typeof value.replaySafe === 'boolean'
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    error['code'] === 'ENOENT' &&
    typeof error['message'] === 'string'
  );
}
