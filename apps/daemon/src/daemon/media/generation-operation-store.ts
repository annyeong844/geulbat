import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ThreadId } from '@geulbat/protocol/ids';

import {
  isJsonValue,
  isRecord,
  tryParseJson,
  type JsonValue,
} from '../runtime-json.js';
import { threadMediaDirPath } from '../sessions/paths.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { isNotFoundError } from '../utils/error.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import {
  MEDIA_GENERATION_OPERATION_SCHEMA_VERSION,
  parseMediaGenerationRecoveryIdentity,
  type MediaGenerationRecoveryIdentity,
} from './contract.js';

const runMediaGenerationOperationSerial = createKeyedSerialRunner();

export interface MediaGenerationOperationSnapshot {
  effectStarted: boolean;
  providerHandle?: string;
  candidate?: JsonValue;
}

export async function prepareMediaGenerationOperation(args: {
  stateRoot: string;
  threadId: ThreadId;
  runId: string;
  callId: string;
  identity: MediaGenerationRecoveryIdentity;
}): Promise<void> {
  const intent = {
    ...args.identity,
    threadId: args.threadId,
    runId: args.runId,
    callId: args.callId,
  } satisfies JsonValue;
  await writeOperationStageOnce(args, 'intent.json', intent);
}

export async function markMediaGenerationEffectStarted(args: {
  stateRoot: string;
  threadId: ThreadId;
  identity: MediaGenerationRecoveryIdentity;
}): Promise<void> {
  await requirePreparedOperation(args);
  await writeOperationStageOnce(args, 'effect-started.json', {
    schemaVersion: MEDIA_GENERATION_OPERATION_SCHEMA_VERSION,
    operationId: args.identity.operationId,
  });
}

export async function recordMediaGenerationProviderHandle(args: {
  stateRoot: string;
  threadId: ThreadId;
  identity: MediaGenerationRecoveryIdentity;
  providerHandle: string;
}): Promise<void> {
  if (args.identity.kind !== 'video' || args.providerHandle.length === 0) {
    throw new Error('media generation provider handle is invalid');
  }
  await requirePreparedOperation(args);
  await writeOperationStageOnce(args, 'provider-handle.json', {
    schemaVersion: MEDIA_GENERATION_OPERATION_SCHEMA_VERSION,
    operationId: args.identity.operationId,
    providerHandle: args.providerHandle,
  });
}

export async function recordMediaGenerationCandidate(args: {
  stateRoot: string;
  threadId: ThreadId;
  identity: MediaGenerationRecoveryIdentity;
  candidate: JsonValue;
}): Promise<void> {
  await requirePreparedOperation(args);
  await writeOperationStageOnce(args, 'candidate.json', {
    schemaVersion: MEDIA_GENERATION_OPERATION_SCHEMA_VERSION,
    operationId: args.identity.operationId,
    candidate: args.candidate,
  });
}

export async function readMediaGenerationOperation(args: {
  stateRoot: string;
  threadId: ThreadId;
  identity: MediaGenerationRecoveryIdentity;
}): Promise<MediaGenerationOperationSnapshot> {
  await requirePreparedOperation(args);
  const directory = operationDirectory(args);
  const [effect, providerHandleRecord, candidateRecord] = await Promise.all([
    readOperationStage(join(directory, 'effect-started.json')),
    readOperationStage(join(directory, 'provider-handle.json')),
    readOperationStage(join(directory, 'candidate.json')),
  ]);
  requireMatchingStageIdentity(effect, args.identity.operationId);
  requireMatchingStageIdentity(providerHandleRecord, args.identity.operationId);
  requireMatchingStageIdentity(candidateRecord, args.identity.operationId);

  const providerHandle =
    providerHandleRecord === null
      ? undefined
      : typeof providerHandleRecord.providerHandle === 'string' &&
          providerHandleRecord.providerHandle.length > 0
        ? providerHandleRecord.providerHandle
        : null;
  if (providerHandle === null) {
    throw new Error('media generation provider handle record is corrupted');
  }
  const candidate =
    candidateRecord === null
      ? undefined
      : isJsonValue(candidateRecord.candidate)
        ? candidateRecord.candidate
        : null;
  if (candidate === null) {
    throw new Error('media generation candidate record is corrupted');
  }
  return {
    effectStarted: effect !== null,
    ...(providerHandle === undefined ? {} : { providerHandle }),
    ...(candidate === undefined ? {} : { candidate }),
  };
}

async function requirePreparedOperation(args: {
  stateRoot: string;
  threadId: ThreadId;
  identity: MediaGenerationRecoveryIdentity;
}): Promise<void> {
  const intent = await readOperationStage(
    join(operationDirectory(args), 'intent.json'),
  );
  const parsedIdentity =
    intent === null ? null : parseMediaGenerationRecoveryIdentity(intent);
  if (
    parsedIdentity === null ||
    !isSameJsonValue(
      recoveryIdentityToJson(parsedIdentity),
      recoveryIdentityToJson(args.identity),
    )
  ) {
    throw new Error('media generation operation identity conflicts');
  }
}

async function writeOperationStageOnce(
  args: {
    stateRoot: string;
    threadId: ThreadId;
    identity: MediaGenerationRecoveryIdentity;
  },
  fileName: string,
  value: JsonValue,
): Promise<void> {
  const path = join(operationDirectory(args), fileName);
  await runMediaGenerationOperationSerial(path, async () => {
    const existing = await readOperationStage(path);
    if (existing !== null) {
      if (!isSameJsonValue(existing, value)) {
        throw new Error(
          `media generation operation stage conflicts: ${fileName}`,
        );
      }
      return;
    }
    await writeTextFileAtomically(path, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
    const written = await readOperationStage(path);
    if (written === null || !isSameJsonValue(written, value)) {
      throw new Error(
        `media generation operation stage did not settle: ${fileName}`,
      );
    }
  });
}

function operationDirectory(args: {
  stateRoot: string;
  threadId: ThreadId;
  identity: MediaGenerationRecoveryIdentity;
}): string {
  if (!/^[a-f0-9]{64}$/u.test(args.identity.operationId)) {
    throw new Error('media generation operation id is invalid');
  }
  return join(
    threadMediaDirPath(args.stateRoot, args.threadId),
    '.generation-operations',
    args.identity.operationId,
  );
}

async function readOperationStage(
  path: string,
): Promise<Record<string, JsonValue> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  const parsed = tryParseJson(raw);
  if (!parsed.ok || !isJsonValue(parsed.value) || !isRecord(parsed.value)) {
    throw new Error('media generation operation stage is corrupted');
  }
  return parsed.value;
}

function requireMatchingStageIdentity(
  value: Record<string, JsonValue> | null,
  operationId: string,
): void {
  if (value !== null && value.operationId !== operationId) {
    throw new Error('media generation operation stage identity conflicts');
  }
}

function recoveryIdentityToJson(
  value: MediaGenerationRecoveryIdentity,
): JsonValue {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    operationId: value.operationId,
    artifactId: value.artifactId,
    argsDigest: value.argsDigest,
  };
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isSameJsonValue(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
