import { Router, type Request, type Response } from 'express';
import type { ProjectId, ThreadId } from '@geulbat/protocol/ids';
import { deleteThreadSession } from '../../../daemon/sessions/delete-thread.js';
import { loadThreadIndex } from '../../../daemon/sessions/threads-index.js';
import { loadThreadDetailSnapshot } from '../../../daemon/sessions/thread-detail.js';
import { isTranscriptCorruptionError } from '../../../daemon/sessions/transcript-log.js';
import type {
  ActiveThreadRunLookup,
  ProjectRegistryLookup,
  ThreadsRoutesContext,
} from './routes-context.js';
import {
  readProjectWorkspaceScopeFromQuery,
  readThreadIdParam,
} from '#web/request/project-scope.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

export function createThreadsRoutes(args: {
  context: ThreadsRoutesContext;
}): Router {
  const { activeRuns, projectRegistry } = args.context;
  return createThreadsRoutesInternal({
    activeRuns,
    projectRegistry,
  });
}

function createThreadsRoutesInternal(args: {
  activeRuns: ActiveThreadRunLookup;
  projectRegistry: ProjectRegistryLookup;
}): Router {
  const router = Router();
  const { activeRuns, projectRegistry } = args;

  router.get('/api/threads', async (req, res) => {
    const projectScope = readProjectScopeOrSendError(
      res,
      req.query['projectId'],
      { projectRegistry },
    );
    if (!projectScope) {
      return;
    }
    const { projectId, workspaceRoot } = projectScope;

    try {
      const entries = await loadThreadIndex(workspaceRoot, {
        isKnownProjectId: projectRegistry.isKnownProjectId,
      });
      const threads = entries
        .filter((e) => e.projectId === projectId)
        .map((e) => ({
          threadId: e.threadId,
          projectId: e.projectId,
          title: e.title,
          lastUpdated: e.lastUpdated,
          messageCount: e.messageCount,
        }));
      res.json({ threads });
    } catch (err: unknown) {
      sendUnexpectedApiError(res, 'threads/list', err);
    }
  });

  router.get('/api/threads/:threadId', async (req, res) => {
    const threadScope = readProjectThreadScope(req, res, { projectRegistry });
    if (!threadScope) {
      return;
    }
    const { projectId, threadId, workspaceRoot } = threadScope;

    try {
      res.json(
        await loadThreadDetailSnapshot({
          workspaceRoot,
          projectId,
          threadId,
        }),
      );
    } catch (err: unknown) {
      if (isTranscriptCorruptionError(err)) {
        sendApiError(res, 'internal', 'thread transcript is corrupted');
        return;
      }
      sendUnexpectedApiError(res, 'threads/detail', err);
    }
  });

  router.delete('/api/threads/:threadId', async (req, res) => {
    const threadScope = readProjectThreadScope(req, res, { projectRegistry });
    if (!threadScope) {
      return;
    }
    const { projectId, threadId, workspaceRoot } = threadScope;

    const activeRun = activeRuns.getRunByThreadId(threadId);
    if (activeRun) {
      sendApiError(
        res,
        'conflict_active_run',
        `thread ${threadId} has an active run`,
        { threadId, activeRunId: activeRun.runId },
      );
      return;
    }

    try {
      const deleted = await deleteThreadSession(workspaceRoot, threadId);
      if (!deleted) {
        sendApiError(res, 'not_found', `thread not found: ${threadId}`);
        return;
      }
      res.json({ ok: true, threadId, projectId });
    } catch (err: unknown) {
      sendUnexpectedApiError(res, 'threads/delete', err);
    }
  });

  return router;
}

interface ProjectThreadScope {
  projectId: ProjectId;
  workspaceRoot: string;
  threadId: ThreadId;
}
function readProjectScopeOrSendError(
  res: Response,
  value: unknown,
  args: {
    projectRegistry: ProjectRegistryLookup;
  },
): { projectId: ProjectId; workspaceRoot: string } | null {
  const projectScope = readProjectWorkspaceScopeFromQuery(value, args);
  if (!projectScope.ok) {
    sendApiError(res, projectScope.code, projectScope.message);
    return null;
  }
  return projectScope;
}

function readProjectThreadScope(
  req: Request,
  res: Response,
  args: {
    projectRegistry: ProjectRegistryLookup;
  },
): ProjectThreadScope | null {
  const projectScope = readProjectScopeOrSendError(
    res,
    req.query['projectId'],
    { projectRegistry: args.projectRegistry },
  );
  if (!projectScope) {
    return null;
  }

  const threadId = readThreadIdParam(req.params['threadId']);
  if (!threadId.ok) {
    sendApiError(res, threadId.code, threadId.message);
    return null;
  }

  return {
    ...projectScope,
    threadId: threadId.value,
  };
}
