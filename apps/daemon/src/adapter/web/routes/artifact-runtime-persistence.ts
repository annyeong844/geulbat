import { Router, type Response } from 'express';
import {
  isJsonValue,
  isArtifactRuntimePersistenceRenderer,
} from '@geulbat/protocol/runtime-persistence';
import type { ArtifactRuntimePersistenceScopeRequest } from '@geulbat/protocol/runtime-persistence';
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
import {
  assertProjectId as assertValidProjectId,
  assertThreadId as assertValidThreadId,
} from '@geulbat/protocol/ids';
import { readRequiredBodyStrings } from '#web/request/string-fields.js';
import {
  readProjectWorkspaceScopeFromBody,
  readProjectWorkspaceScopeFromQuery,
} from '#web/request/project-scope.js';
import { sendArtifactRuntimePersistenceRouteError } from '../protocol/map-errors.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { registerInputRefDeleteRoute } from './input-ref-routes.js';
import type { ProjectScopedRoutesContext } from './routes-context.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { JsonValue } from '@geulbat/protocol/runtime-persistence';
import type { ArtifactRuntimePersistenceStateInputRefResponse } from '@geulbat/protocol/runtime-persistence';

const logger = createLogger('web/artifact-runtime-persistence');

export function createArtifactRuntimePersistenceRoutes(args: {
  projectRegistry: ProjectScopedRoutesContext['projectRegistry'];
}): Router {
  const router = Router();
  const { projectRegistry } = args;

  router.post('/api/artifact-runtime-persistence/load', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const request = readArtifactRuntimePersistenceBaseRequestOrSendError(
      res,
      body,
      {
        projectRegistry,
      },
    );
    if (!request) {
      return;
    }

    try {
      const result = await loadArtifactRuntimePersistenceState(
        request.workspaceRoot,
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

      const projectScope = readProjectScopeOrSendError(
        res,
        readProjectWorkspaceScopeFromQuery(req.query['projectId'], {
          projectRegistry,
        }),
      );
      if (!projectScope) {
        return;
      }

      try {
        const result =
          await writeArtifactRuntimePersistenceStateInputRefFromStream({
            workspaceRoot: projectScope.workspaceRoot,
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
    projectRegistry,
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
    const body = req.body as Record<string, unknown> | undefined;
    const request = readArtifactRuntimePersistenceBaseRequestOrSendError(
      res,
      body,
      {
        projectRegistry,
      },
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
      request.workspaceRoot,
    );
    if (!stateInput) {
      return;
    }

    try {
      const result = await saveArtifactRuntimePersistenceState(
        request.workspaceRoot,
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
    const body = req.body as Record<string, unknown> | undefined;
    const request = readArtifactRuntimePersistenceBaseRequestOrSendError(
      res,
      body,
      {
        projectRegistry,
      },
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
        request.workspaceRoot,
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
  workspaceRoot: string;
  scope: ArtifactRuntimePersistenceScopeRequest;
}

function readArtifactRuntimePersistenceBaseRequestOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
  args: {
    projectRegistry: ProjectScopedRoutesContext['projectRegistry'];
  },
): ArtifactRuntimePersistenceLoadRequest | null {
  const scope = readArtifactRuntimePersistenceScope(body);
  if (!scope.ok) {
    sendApiError(res, 'bad_request', scope.message);
    return null;
  }
  const projectScope = readProjectWorkspaceScopeFromBody(body, args);
  if (!projectScope.ok) {
    sendApiError(res, projectScope.code, projectScope.message);
    return null;
  }
  return {
    workspaceRoot: projectScope.workspaceRoot,
    scope: scope.value,
  };
}

async function readSaveStateInputOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
  workspaceRoot: string,
): Promise<ArtifactRuntimePersistenceSaveStateInput | null> {
  const hasState = Object.prototype.hasOwnProperty.call(body ?? {}, 'state');
  const hasStateRef = Object.prototype.hasOwnProperty.call(
    body ?? {},
    'stateRef',
  );
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

function readProjectScopeOrSendError(
  res: Response,
  projectScope: ReturnType<typeof readProjectWorkspaceScopeFromQuery>,
): { workspaceRoot: string } | null {
  if (!projectScope.ok) {
    sendApiError(res, projectScope.code, projectScope.message);
    return null;
  }
  return { workspaceRoot: projectScope.workspaceRoot };
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
  const required = readRequiredBodyStrings(body, [
    'projectId',
    'threadId',
    'renderer',
    'artifactId',
  ] as const);
  if (!required.ok) {
    return required;
  }

  const { projectId, threadId, renderer, artifactId } = required.values;
  const persistenceEpoch = readPersistenceEpoch(body?.['persistenceEpoch']);
  if (!persistenceEpoch.ok) {
    return { ok: false, message: persistenceEpoch.message };
  }
  let validatedProjectId: ArtifactRuntimePersistenceScopeRequest['projectId'];
  let validatedThreadId: ArtifactRuntimePersistenceScopeRequest['threadId'];
  try {
    validatedProjectId = assertValidProjectId(projectId);
  } catch {
    return { ok: false, message: `invalid projectId: ${projectId}` };
  }
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
      projectId: validatedProjectId,
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
