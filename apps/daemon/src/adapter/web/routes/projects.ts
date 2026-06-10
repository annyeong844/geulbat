import { Router, type Response } from 'express';
import type { ProjectId } from '@geulbat/protocol/ids';
import {
  getAppErrorCode,
  getErrorMessage,
} from '../../../daemon/utils/error.js';
import type {
  ActiveProjectRunLookup,
  ProjectRegistryLookup,
  ProjectRouteStore,
  ProjectsRoutesContext,
} from './routes-context.js';
import { readRequiredBodyString } from '#web/request/string-fields.js';
import { readProjectIdParam } from '#web/request/project-scope.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

export function createProjectsRoutes(args: {
  context: ProjectsRoutesContext;
}): Router {
  const { activeRuns, projectStore, projectRegistry } = args.context;
  return createProjectsRoutesInternal({
    activeRuns,
    projectStore,
    projectRegistry,
  });
}

function createProjectsRoutesInternal(args: {
  activeRuns: ActiveProjectRunLookup;
  projectStore: ProjectRouteStore;
  projectRegistry: ProjectRegistryLookup;
}): Router {
  const router = Router();
  const { activeRuns, projectStore, projectRegistry } = args;

  router.get('/api/projects', (_req, res) => {
    res.status(200).json(projectStore.snapshotProjectRegistry());
  });

  router.post('/api/projects', async (req, res) => {
    const label = readProjectLabelOrSendError(
      res,
      req.body as Record<string, unknown> | undefined,
    );
    if (!label) {
      return;
    }

    try {
      const snapshot = await projectStore.createProject(label);
      res.status(201).json(snapshot);
    } catch (error: unknown) {
      sendProjectRegistryError(res, 'projects/create', error);
    }
  });

  router.patch('/api/projects/:projectId', async (req, res) => {
    const projectId = readProjectIdOrSendError(res, req.params['projectId'], {
      projectRegistry,
    });
    if (!projectId) {
      return;
    }

    const label = readProjectLabelOrSendError(
      res,
      req.body as Record<string, unknown> | undefined,
    );
    if (!label) {
      return;
    }

    try {
      const snapshot = await projectStore.renameProject(projectId, label);
      res.status(200).json(snapshot);
    } catch (error: unknown) {
      sendProjectRegistryError(res, 'projects/rename', error);
    }
  });

  router.delete('/api/projects/:projectId', async (req, res) => {
    const projectId = readProjectIdOrSendError(res, req.params['projectId'], {
      projectRegistry,
    });
    if (!projectId) {
      return;
    }

    const activeRun = activeRuns.getRunByProjectId(projectId);
    if (activeRun) {
      sendApiError(
        res,
        'conflict_active_run',
        `project ${projectId} has an active run`,
        {
          projectId,
          threadId: activeRun.threadId,
          activeRunId: activeRun.runId,
        },
      );
      return;
    }

    try {
      const snapshot = await projectStore.deleteProject(projectId);
      res.status(200).json(snapshot);
    } catch (error: unknown) {
      sendProjectRegistryError(res, 'projects/delete', error);
    }
  });

  return router;
}

function readProjectIdOrSendError(
  res: Response,
  value: string | undefined,
  args: {
    projectRegistry: ProjectRegistryLookup;
  },
): ProjectId | null {
  const projectId = readProjectIdParam(value, args);
  if (!projectId.ok) {
    sendApiError(res, projectId.code, projectId.message);
    return null;
  }
  return projectId.value;
}

function readProjectLabelOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
): string | null {
  const label = readRequiredBodyString(body, 'label');
  if (!label.ok) {
    sendApiError(res, 'bad_request', label.message);
    return null;
  }
  return label.value;
}

function sendProjectRegistryError(
  res: Response,
  logContext: string,
  error: unknown,
): void {
  const code = getAppErrorCode(error);
  if (code) {
    sendApiError(res, code, getErrorMessage(error));
    return;
  }
  sendUnexpectedApiError(res, logContext, error);
}
