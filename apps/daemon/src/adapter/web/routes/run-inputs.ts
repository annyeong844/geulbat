import { Router } from 'express';
import type { RunPromptInputRefResponse } from '@geulbat/protocol/run-contract';

import {
  deleteRunPromptInputRefPath,
  writeRunPromptInputRefFromStream,
  readRunPromptInputRefPath,
} from '../../../daemon/sessions/prompt-input-ref-store.js';
import { readProjectWorkspaceScopeFromQuery } from '#web/request/project-scope.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { registerInputRefDeleteRoute } from './input-ref-routes.js';
import type { ProjectScopedRoutesContext } from './routes-context.js';

export function createRunInputRoutes(args: {
  projectRegistry: ProjectScopedRoutesContext['projectRegistry'];
}): Router {
  const router = Router();
  const { projectRegistry } = args;

  router.post('/api/run/prompt-inputs', async (req, res) => {
    if (req.is('application/json')) {
      sendApiError(
        res,
        'bad_request',
        'run prompt input upload must use a streaming content type',
      );
      return;
    }

    const projectScope = readProjectWorkspaceScopeFromQuery(
      req.query['projectId'],
      { projectRegistry },
    );
    if (!projectScope.ok) {
      sendApiError(res, projectScope.code, projectScope.message);
      return;
    }

    try {
      const result = await writeRunPromptInputRefFromStream({
        workspaceRoot: projectScope.workspaceRoot,
        input: req,
      });
      const response: RunPromptInputRefResponse = {
        ok: true,
        ...result,
      };
      res.status(201).json(response);
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'run/prompt-inputs', error);
    }
  });

  registerInputRefDeleteRoute({
    router,
    path: '/api/run/prompt-inputs',
    projectRegistry,
    refQueryName: 'promptRef',
    logContext: 'run/prompt-inputs/delete',
    readRefPath: ({ workspaceRoot, ref }) =>
      readRunPromptInputRefPath({ workspaceRoot, promptRef: ref }),
    deleteRefPath: deleteRunPromptInputRefPath,
  });

  return router;
}
