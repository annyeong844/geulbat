import { Router } from 'express';
import type { RunPromptInputRefResponse } from '@geulbat/protocol/run-contract';

import {
  deleteRunPromptInputRefPath,
  writeRunPromptInputRefFromStream,
  readRunPromptInputRefPath,
} from '../../../daemon/sessions/prompt-input-ref-store.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { registerInputRefDeleteRoute } from './input-ref-routes.js';

export function createRunInputRoutes(args: { homeStateRoot: string }): Router {
  const router = Router();
  const { homeStateRoot } = args;

  router.post('/api/run/prompt-inputs', async (req, res) => {
    if (req.is('application/json')) {
      sendApiError(
        res,
        'bad_request',
        'run prompt input upload must use a streaming content type',
      );
      return;
    }

    try {
      const result = await writeRunPromptInputRefFromStream({
        workspaceRoot: homeStateRoot,
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
    resolveWorkspaceRoot: () => homeStateRoot,
    refQueryName: 'promptRef',
    logContext: 'run/prompt-inputs/delete',
    readRefPath: ({ workspaceRoot, ref }) =>
      readRunPromptInputRefPath({ workspaceRoot, promptRef: ref }),
    deleteRefPath: deleteRunPromptInputRefPath,
  });

  return router;
}
