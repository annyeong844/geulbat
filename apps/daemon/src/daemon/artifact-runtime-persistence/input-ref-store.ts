import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ErrorCode } from '../error-codes.js';
import {
  claimInputRefFilePath,
  deleteInputRefFilePath,
  readInputRefFilePath,
  writeInputRefFileFromStream,
  type InputRefFilePathResult,
  type InputRefFileStoreConfig,
} from '../utils/input-ref-file-store.js';
import type { JsonValue } from './contract.js';
import { isRuntimePersistenceJsonValue } from './contract.js';
import { tryParseJson } from '../runtime-json.js';

export const ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE: InputRefFileStoreConfig =
  Object.freeze({
    kind: 'artifact_runtime_state',
    refPrefix: 'artifact-runtime-state-input:',
    directoryName: 'artifact-runtime-state-inputs',
    fileExtension: '.json',
    invalidPrefixMessage:
      'stateRef must be an artifact-runtime-state-input reference.',
    invalidIdMessage:
      'stateRef is not a valid artifact-runtime-state-input reference.',
    notFileMessage:
      'stateRef does not point to an artifact runtime state input.',
    notFoundMessage: 'stateRef was not found.',
    claimedMessage: 'stateRef is already claimed by another operation.',
  });

interface ArtifactRuntimePersistenceStateInputRefWriteResult {
  stateRef: string;
  byteLength: number;
}

type ArtifactRuntimePersistenceStateInputRefReadResult =
  | { ok: true; path: string; state: JsonValue | null }
  | {
      ok: false;
      code: Extract<
        ErrorCode,
        'bad_request' | 'conflict' | 'not_found' | 'persistence_blocked'
      >;
      message: string;
    };

type ArtifactRuntimePersistenceStateInputRefPathResult = InputRefFilePathResult;

export async function writeArtifactRuntimePersistenceStateInputRefFromStream(args: {
  workspaceRoot: string;
  input: Readable;
}): Promise<ArtifactRuntimePersistenceStateInputRefWriteResult> {
  const uploaded = await writeInputRefFileFromStream({
    workspaceRoot: args.workspaceRoot,
    input: args.input,
    config: ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE,
  });
  return {
    stateRef: uploaded.ref,
    byteLength: uploaded.byteLength,
  };
}

export async function readArtifactRuntimePersistenceStateInputRef(args: {
  workspaceRoot: string;
  stateRef: string;
}): Promise<ArtifactRuntimePersistenceStateInputRefReadResult> {
  const resolvedRef = await claimInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.stateRef,
    config: ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE,
  });
  if (!resolvedRef.ok) {
    return resolvedRef;
  }

  try {
    const raw = await readFile(resolvedRef.path, 'utf8');
    const parsedState = tryParseJson(raw);
    if (!parsedState.ok || !isRuntimePersistenceJsonValue(parsedState.value)) {
      await deleteInputRefFilePath(resolvedRef.path);
      return {
        ok: false,
        code: 'persistence_blocked',
        message: 'stateRef payload must be JSON-serializable state.',
      };
    }
    return {
      ok: true,
      path: resolvedRef.path,
      state: parsedState.value ?? null,
    };
  } catch (error: unknown) {
    await deleteInputRefFilePath(resolvedRef.path);
    throw error;
  }
}

export async function readArtifactRuntimePersistenceStateInputRefPath(args: {
  workspaceRoot: string;
  stateRef: string;
}): Promise<ArtifactRuntimePersistenceStateInputRefPathResult> {
  return readInputRefFilePath({
    workspaceRoot: args.workspaceRoot,
    ref: args.stateRef,
    config: ARTIFACT_RUNTIME_STATE_INPUT_REF_STORE,
  });
}

export async function deleteArtifactRuntimePersistenceStateInputRefPath(
  path: string,
): Promise<void> {
  await deleteInputRefFilePath(path);
}
