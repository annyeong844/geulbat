import { Router, type Response } from 'express';
import { listTree } from '../../../daemon/files/list-tree.js';
import { readFile } from '../../../daemon/files/read-file.js';
import {
  replaceBinaryFile,
  saveBinaryFile,
} from '../../../daemon/files/save-binary-file.js';
import { saveFile } from '../../../daemon/files/save-file.js';
import {
  readBodyString,
  readRequiredBodyStrings,
  readRequiredQueryString,
} from '#web/request/string-fields.js';
import {
  readProjectWorkspaceScopeFromBody,
  readProjectWorkspaceScopeFromQuery,
} from '#web/request/project-scope.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';
import { sendFilesRouteError } from '../protocol/map-errors.js';
import type { ProjectScopedRoutesContext } from './routes-context.js';

type FilesRoutesProjectRegistry = ProjectScopedRoutesContext['projectRegistry'];

export function createFilesRoutes(args: {
  projectRegistry: FilesRoutesProjectRegistry;
}): Router {
  const router = Router();
  const { projectRegistry } = args;

  registerFilesTreeRoute(router, projectRegistry);
  registerFileReadRoute(router, projectRegistry);
  registerTextFileSaveRoute(router, projectRegistry);
  registerBinaryFileSaveRoute(router, projectRegistry);
  registerBinaryFileReplaceRoute(router, projectRegistry);

  return router;
}

function registerFilesTreeRoute(
  router: Router,
  projectRegistry: FilesRoutesProjectRegistry,
): void {
  router.get('/api/files/tree', async (req, res) => {
    const request = readProjectScopeOrSendError(
      res,
      readProjectWorkspaceScopeFromQuery(req.query['projectId'], {
        projectRegistry,
      }),
    );
    await respondWithRouteResult({
      res,
      request,
      logContext: 'files/tree',
      sendError: sendUnexpectedApiError,
      run: async ({ projectId, workspaceRoot }) => ({
        projectId,
        tree: await listTree(workspaceRoot),
      }),
    });
  });
}

function registerFileReadRoute(
  router: Router,
  projectRegistry: FilesRoutesProjectRegistry,
): void {
  router.get('/api/files/read', async (req, res) => {
    const projectScope = readProjectScopeOrSendError(
      res,
      readProjectWorkspaceScopeFromQuery(req.query['projectId'], {
        projectRegistry,
      }),
    );
    const pathResult = readRequiredQueryString(req.query['path'], 'path');
    if (!pathResult.ok) {
      sendApiError(res, 'bad_request', pathResult.message);
      return;
    }
    await respondWithRouteResult({
      res,
      request:
        projectScope && pathResult.ok
          ? {
              workspaceRoot: projectScope.workspaceRoot,
              path: pathResult.value,
            }
          : null,
      logContext: 'files/read',
      run: (request) => readFile(request.workspaceRoot, request.path),
    });
  });
}

function registerTextFileSaveRoute(
  router: Router,
  projectRegistry: FilesRoutesProjectRegistry,
): void {
  router.post('/api/files/save', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const requestFields = readProjectScopedBodyStringsOrSendError(
      res,
      body,
      ['projectId', 'path', 'content'] as const,
      {
        projectRegistry,
      },
    );
    const versionTokenResult =
      requestFields === null ? null : readBodyString(body, 'versionToken');
    if (versionTokenResult && !versionTokenResult.ok) {
      sendApiError(res, 'bad_request', versionTokenResult.message);
      return;
    }
    await respondWithRouteResult({
      res,
      request:
        requestFields && versionTokenResult !== null && versionTokenResult.ok
          ? {
              workspaceRoot: requestFields.workspaceRoot,
              path: requestFields.values.path,
              content: requestFields.values.content,
              versionToken: versionTokenResult.value,
            }
          : null,
      logContext: 'files/save',
      run: (request) =>
        saveFile(
          request.workspaceRoot,
          request.path,
          request.content,
          request.versionToken,
        ),
    });
  });
}

function registerBinaryFileSaveRoute(
  router: Router,
  projectRegistry: FilesRoutesProjectRegistry,
): void {
  router.post('/api/files/save-binary', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const requestFields = readProjectScopedBodyStringsOrSendError(
      res,
      body,
      ['projectId', 'path', 'contentBase64'] as const,
      {
        projectRegistry,
      },
    );
    const content =
      requestFields === null
        ? null
        : readBinaryContentOrSendError(
            res,
            body,
            requestFields.values.contentBase64,
          );
    await respondWithRouteResult({
      res,
      request:
        requestFields && content
          ? {
              workspaceRoot: requestFields.workspaceRoot,
              path: requestFields.values.path,
              content,
            }
          : null,
      logContext: 'files/save-binary',
      run: (request) =>
        saveBinaryFile(request.workspaceRoot, request.path, request.content),
    });
  });
}

function registerBinaryFileReplaceRoute(
  router: Router,
  projectRegistry: FilesRoutesProjectRegistry,
): void {
  router.post('/api/files/replace-binary', async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const requestFields = readProjectScopedBodyStringsOrSendError(
      res,
      body,
      ['projectId', 'path', 'contentBase64', 'versionToken'] as const,
      {
        projectRegistry,
      },
    );
    const content =
      requestFields === null
        ? null
        : readBinaryContentOrSendError(
            res,
            body,
            requestFields.values.contentBase64,
          );
    await respondWithRouteResult({
      res,
      request:
        requestFields && content
          ? {
              workspaceRoot: requestFields.workspaceRoot,
              path: requestFields.values.path,
              content,
              versionToken: requestFields.values.versionToken,
            }
          : null,
      logContext: 'files/replace-binary',
      run: (request) =>
        replaceBinaryFile(
          request.workspaceRoot,
          request.path,
          request.content,
          request.versionToken,
        ),
    });
  });
}

function readProjectScopedBodyStringsOrSendError<const T extends string>(
  res: Response,
  body: Record<string, unknown> | undefined,
  names: readonly T[],
  args: {
    projectRegistry: FilesRoutesProjectRegistry;
  },
): { workspaceRoot: string; values: Record<T, string> } | null {
  const bodyResult = readRequiredBodyStrings(body, names);
  if (!bodyResult.ok) {
    sendApiError(res, 'bad_request', bodyResult.message);
    return null;
  }
  const projectScope = readProjectScopeOrSendError(
    res,
    readProjectWorkspaceScopeFromBody(body, args),
  );
  if (!projectScope) {
    return null;
  }
  return {
    workspaceRoot: projectScope.workspaceRoot,
    values: bodyResult.values,
  };
}

function readBinaryContentOrSendError(
  res: Response,
  body: Record<string, unknown> | undefined,
  contentBase64: string,
): Buffer | null {
  const mimeType = body?.['mimeType'];
  if (mimeType !== undefined && typeof mimeType !== 'string') {
    sendApiError(res, 'bad_request', 'mimeType must be a string');
    return null;
  }
  const content = decodeBase64Body(contentBase64);
  if (!content) {
    sendApiError(res, 'bad_request', 'contentBase64 must be valid base64');
    return null;
  }
  return content;
}

function readProjectScopeOrSendError(
  res: Response,
  projectScope:
    | ReturnType<typeof readProjectWorkspaceScopeFromBody>
    | ReturnType<typeof readProjectWorkspaceScopeFromQuery>,
): { projectId: string; workspaceRoot: string } | null {
  if (!projectScope.ok) {
    sendApiError(res, projectScope.code, projectScope.message);
    return null;
  }
  return projectScope;
}

function decodeBase64Body(value: string): Buffer | null {
  if (value === '') {
    return Buffer.alloc(0);
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

async function respondWithRouteResult<Request, Result>(args: {
  res: Response;
  request: Request | null;
  logContext: string;
  run: (request: Request) => Promise<Result>;
  sendError?: (res: Response, logContext: string, error: unknown) => void;
}): Promise<void> {
  const {
    res,
    request,
    logContext,
    run,
    sendError = sendFilesRouteError,
  } = args;
  if (!request) {
    return;
  }
  try {
    res.json(await run(request));
  } catch (error: unknown) {
    sendError(res, logContext, error);
  }
}
