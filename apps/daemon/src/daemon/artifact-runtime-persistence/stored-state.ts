import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  JsonValue,
  ArtifactRuntimePersistenceScopeRequest,
} from '@geulbat/protocol/runtime-persistence';
import { tryDecodeJson } from '@geulbat/protocol/runtime-utils';

import { isNotFoundError } from '../utils/error.js';
import {
  classifyRuntimePersistenceError,
  PersistenceConflictError,
} from './errors.js';
import {
  matchesRuntimePersistenceScope,
  parsePersistedRuntimeState,
  type PersistedRuntimeStateSchema,
} from './schema.js';

export async function assertExpectedRuntimePersistenceRevision(
  filePath: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
  expectedRevision: string | null,
): Promise<{
  payload: PersistedRuntimeStateSchema;
  byteLength: number;
} | null> {
  const current = await readPersistedRuntimeState(filePath, scope);
  const currentRevision = current?.payload.revision ?? null;
  if (currentRevision !== expectedRevision) {
    throw new PersistenceConflictError(
      'runtime persistence revision does not match expectedRevision',
    );
  }
  return current;
}

export function buildPersistedRuntimeState(
  scope: ArtifactRuntimePersistenceScopeRequest,
  state: JsonValue | null,
): {
  payload: PersistedRuntimeStateSchema;
  serialized: string;
  byteLength: number;
} {
  const payload: PersistedRuntimeStateSchema = {
    version: 1,
    scope: {
      threadId: scope.threadId,
      renderer: scope.renderer,
      artifactId: scope.artifactId,
      persistenceEpoch: scope.persistenceEpoch,
    },
    revision: randomUUID(),
    state,
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  return {
    payload,
    serialized,
    byteLength: Buffer.byteLength(serialized, 'utf8'),
  };
}

export async function readPersistedRuntimeState(
  filePath: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
): Promise<{
  payload: PersistedRuntimeStateSchema;
  byteLength: number;
} | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw classifyRuntimePersistenceError(
      'runtime persistence read failed',
      error,
    );
  }

  const decoded = tryDecodeJson(raw, parsePersistedRuntimeState);
  if (!decoded.ok) {
    throw new PersistenceConflictError(
      'runtime persistence payload is invalid',
      { cause: new Error('invalid runtime persistence payload') },
    );
  }
  const persisted = decoded.value;
  if (!matchesRuntimePersistenceScope(persisted, scope)) {
    throw new PersistenceConflictError(
      'runtime persistence scope does not match request',
      { cause: new Error('runtime persistence scope mismatch') },
    );
  }
  return {
    payload: persisted,
    byteLength: Buffer.byteLength(raw, 'utf8'),
  };
}
