import { Router, type Response } from 'express';
import {
  isJsonValue,
  isArtifactRuntimePersistenceRenderer,
} from '@geulbat/protocol/runtime-persistence';
import type {
  ArtifactRuntimePersistenceScopeRequest,
  ArtifactRuntimePersistenceStateInputRefResponse,
  JsonValue,
} from '@geulbat/protocol/runtime-persistence';
import { isRecord } from '../../../daemon/runtime-json.js';
import {
  clearArtifactRuntimePersistenceState,
  loadArtifactRuntimePersistenceState,
  saveArtifactRuntimePersistenceState,
} from '../../../daemon/artifact-runtime-persistence/store.js';
import {
  deleteArtifactRuntimePersistenceStateInputRefPath,
  readArtifactRuntimePersistenceStateInputRef,
  readArtifactRuntimePersistenceStateInputRefPath,
  writeArtifactRuntimePersistenceStateInputRefFromStream,
} from '../../../daemon/artifact-runtime-persistence/input-ref-store.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import { readRequiredBodyStrings } from '#web/request/string-fields.js';
import { sendArtifactRuntimePersistenceRouteError } from '../protocol/map-errors.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { registerInputRefDeleteRoute } from './input-ref-routes.js';
import { createLogger } from '@geulbat/structured-logger/logger';
const logger = createLogger('web/artifact-runtime-persistence');

export function createArtifactRuntimePersistenceRoutes(args: {
  homeStateRoot: string;
}): Router {
  const router = Router();

  router.post('/api/artifact-runtime-persistence/load', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const request = readArtifactRuntimePersistenceBaseRequestOrSendError(
      res,
      body,
      args,
    );
    if (!request) {
      return;
    }

    try {
      const result = await loadArtifactRuntimePersistenceState(
        request.stateRoot,
        request.scope,
      );
      res.json(result);
    } catch (error: unknown) {
      sendArtifactRuntimePersistenceRouteError(
        res,
        'artifact-runtime-persistence/load',
        error,
      );
    }
  });

  router.post(
    '/api/artifact-runtime-persistence/state-inputs',
    async (req, res) => {
      if (req.is('application/json')) {
        sendApiError(
          res,
          'bad_request',
          'runtime persistence state input upload must use a streaming content type',
        );
        return;
      }

      try {
        const result =
          await writeArtifactRuntimePersistenceStateInputRefFromStream({
            workspaceRoot: args.homeStateRoot,
            input: req,
          });
        const response: ArtifactRuntimePersistenceStateInputRefResponse = {
          ok: true,
          ...result,
        };
        res.status(201).json(response);
      } catch (error: unknown) {
        sendUnexpectedApiError(
          res,
          'artifact-runtime-persistence/state-inputs',
          error,
        );
      }
    },
  );

  registerInputRefDeleteRoute({
    router,
    path: '/api/artifact-runtime-persistence/state-inputs',
    resolveWorkspaceRoot: () => args.homeStateRoot,
    refQueryName: 'stateRef',
    logContext: 'artifact-runtime-persistence/state-inputs/delete',
    readRefPath: ({ workspaceRoot, ref }) =>
      readArtifactRuntimePersistenceStateInputRefPath({
        workspaceRoot,
        stateRef: ref,
      }),
    deleteRefPath: deleteArtifactRuntimePersistenceStateInputRefPath,
  });

  router.post('/api/artifact-runtime-persistence/save', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const request = readArtifactRuntimePersistenceBaseRequestOrSendError(
      res,
      body,
      args,
    );
    if (!request) {
      return;
    }
    const expectedRevision = readOptionalRevision(body?.['expectedRevision']);
    if (!expectedRevision.ok) {
      sendApiError(res, 'bad_request', expectedRevision.message);
      return;
    }
    const stateInput = await readSaveStateInputOrSendError(
      res,
      body,
      request.stateRoot,
    );
    if (!stateInput) {
      return;
    }

    try {
      const result = await saveArtifactRuntimePersistenceState(
        request.stateRoot,
        request.scope,
        stateInput.state,
        expectedRevision.value,
      );
      if (stateInput.kind === 'ref') {
        await deleteStateInputRefAfterUse(stateInput);
      }
      res.json(result);
    } catch (error: unknown) {
      if (stateInput.kind === 'ref') {
        await deleteStateInputRefAfterUse(stateInput);
      }
      sendArtifactRuntimePersistenceRouteError(
        res,
        'artifact-runtime-persistence/save',
        error,
      );
    }
  });

  router.post('/api/artifact-runtime-persistence/clear', async (req, res) => {
    const body = isRecord(req.body) ? req.body : undefined;
    const request = readArtifactRuntimePersistenceBaseRequestOrSendError(
      res,
      body,
      args,
    );
    if (!request) {
      return;
    }
    const expectedRevision = readOptionalRevision(body?.['expectedRevision']);
    if (!expectedRevision.ok) {
      sendApiError(res, 'bad_request', expectedRevision.message);
      return;
    }

    try {
      const result = await clearArtifactRuntimePersistenceState(
        request.stateRoot,
        request.scope,
        expectedRevision.value,
      );
      res.json(result);
    } catch (error: unknown) {
      sendArtifactRuntimePersistenceRouteError(
        res,
        'artifact-runtime-persistence/clear',
        error,
      );
    }
  });

  return router;
}

type ArtifactRuntimePersistenceSaveStateInput =
  | { kind: 'body'; state: JsonValue | null }
  | { kind: 'ref'; stateRef: string; path: string; state: JsonValue | null };

interface ArtifactRuntimePersistenceLoadRequest {
  stateRoot: string;
  scope: ArtifactRuntimePersistenceScopeRequest;
}

function readArtifactRuntimePersistenceBaseRequestOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
  args: { homeStateRoot: string },
): ArtifactRuntimePersistenceLoadRequest | null {
  const scope = readArtifactRuntimePersistenceScope(body);
  if (!scope.ok) {
    sendApiError(res, 'bad_request', scope.message);
    return null;
  }
  return {
    stateRoot: args.homeStateRoot,
    scope: scope.value,
  };
}

async function readSaveStateInputOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
  workspaceRoot: string,
): Promise<ArtifactRuntimePersistenceSaveStateInput | null> {
  const hasState = Object.hasOwn(body ?? {}, 'state');
  const hasStateRef = Object.hasOwn(body ?? {}, 'stateRef');
  if (!hasState && !hasStateRef) {
    sendApiError(res, 'bad_request', 'state or stateRef is required');
    return null;
  }
  if (hasState && hasStateRef) {
    sendApiError(
      res,
      'bad_request',
      'exactly one of state or stateRef is required',
    );
    return null;
  }

  if (hasStateRef) {
    const stateRef = body?.['stateRef'];
    if (typeof stateRef !== 'string') {
      sendApiError(res, 'bad_request', 'stateRef must be a string');
      return null;
    }
    const resolvedRef = await readArtifactRuntimePersistenceStateInputRef({
      workspaceRoot,
      stateRef,
    });
    if (!resolvedRef.ok) {
      sendApiError(res, resolvedRef.code, resolvedRef.message);
      return null;
    }
    return {
      kind: 'ref',
      stateRef,
      path: resolvedRef.path,
      state: resolvedRef.state,
    };
  }

  if (!isJsonValue(body?.['state'])) {
    sendApiError(res, 'persistence_blocked', 'state must be JSON-serializable');
    return null;
  }
  return { kind: 'body', state: body?.['state'] ?? null };
}

async function deleteStateInputRefAfterUse(
  input: Extract<ArtifactRuntimePersistenceSaveStateInput, { kind: 'ref' }>,
): Promise<void> {
  try {
    await deleteArtifactRuntimePersistenceStateInputRefPath(input.path);
  } catch (error: unknown) {
    logger.warn('failed to delete consumed runtime persistence state ref:', {
      stateRef: input.stateRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readArtifactRuntimePersistenceScope(
  body: Record<string, unknown> | undefined,
):
  | {
      ok: true;
      value: ArtifactRuntimePersistenceScopeRequest;
    }
  | { ok: false; message: string } {
  if (body && 'projectId' in body) {
    return { ok: false, message: 'projectId is not supported' };
  }
  const required = readRequiredBodyStrings(body, [
    'threadId',
    'renderer',
    'artifactId',
  ] as const);
  if (!required.ok) {
    return required;
  }

  const threadId = required.read('threadId');
  const renderer = required.read('renderer');
  const artifactId = required.read('artifactId');
  const persistenceEpoch = readPersistenceEpoch(body?.['persistenceEpoch']);
  if (!persistenceEpoch.ok) {
    return { ok: false, message: persistenceEpoch.message };
  }
  let validatedThreadId: ArtifactRuntimePersistenceScopeRequest['threadId'];
  try {
    validatedThreadId = assertValidThreadId(threadId);
  } catch {
    return { ok: false, message: `invalid threadId: ${threadId}` };
  }
  if (!isArtifactRuntimePersistenceRenderer(renderer)) {
    return { ok: false, message: `invalid renderer: ${renderer}` };
  }

  return {
    ok: true,
    value: {
      threadId: validatedThreadId,
      renderer,
      artifactId,
      persistenceEpoch: persistenceEpoch.value,
    },
  };
}

function readPersistenceEpoch(
  value: unknown,
): { ok: true; value: number } | { ok: false; message: string } {
  const persistenceEpoch =
    typeof value === 'number' && Number.isInteger(value) ? value : null;
  if (persistenceEpoch === null || persistenceEpoch < 0) {
    return {
      ok: false,
      message: 'persistenceEpoch must be a non-negative integer',
    };
  }
  return { ok: true, value: persistenceEpoch };
}

function readOptionalRevision(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value === 'string') {
    return { ok: true, value };
  }
  return { ok: false, message: 'expectedRevision must be a string or null' };
}
