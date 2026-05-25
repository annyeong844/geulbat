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
  assertProjectId as assertValidProjectId,
  assertThreadId as assertValidThreadId,
} from '@geulbat/protocol/ids';
import { readRequiredBodyStrings } from '#web/request/string-fields.js';
import { readProjectWorkspaceScopeFromBody } from '#web/request/project-scope.js';
import { sendArtifactRuntimePersistenceRouteError } from '../protocol/map-errors.js';
import { sendApiError } from '#web/response/send-api-error.js';
import type { ProjectScopedRoutesContext } from './routes-context.js';

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
    if (!body || !('state' in body)) {
      sendApiError(res, 'bad_request', 'state is required');
      return;
    }
    if (!isJsonValue(body['state'])) {
      sendApiError(
        res,
        'persistence_blocked',
        'state must be JSON-serializable',
      );
      return;
    }

    try {
      const result = await saveArtifactRuntimePersistenceState(
        request.workspaceRoot,
        request.scope,
        body['state'],
        expectedRevision.value,
      );
      res.json(result);
    } catch (error: unknown) {
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
