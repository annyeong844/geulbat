import type { Request, Response, Router } from 'express';

import type { ErrorCode } from '../../../daemon/error-codes.js';
import { readRequiredQueryString } from '#web/request/string-fields.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

type InputRefRoutePathResult =
  | { ok: true; path: string }
  | {
      ok: false;
      code: Extract<ErrorCode, 'bad_request' | 'conflict' | 'not_found'>;
      message: string;
    };

export function registerInputRefDeleteRoute(args: {
  router: Router;
  path: string;
  refQueryName: string;
  logContext: string;
  resolveWorkspaceRoot: (request: Request, response: Response) => string | null;
  readRefPath: (args: {
    workspaceRoot: string;
    ref: string;
  }) => Promise<InputRefRoutePathResult>;
  deleteRefPath: (path: string) => Promise<void>;
}): void {
  const {
    router,
    path,
    resolveWorkspaceRoot,
    refQueryName,
    logContext,
    readRefPath,
    deleteRefPath,
  } = args;

  router.delete(path, async (req, res) => {
    const workspaceRoot = resolveWorkspaceRoot(req, res);
    if (workspaceRoot === null) {
      return;
    }

    const ref = readRequiredQueryString(req.query[refQueryName], refQueryName);
    if (!ref.ok) {
      sendApiError(res, 'bad_request', ref.message);
      return;
    }

    try {
      const resolvedRef = await readRefPath({
        workspaceRoot,
        ref: ref.value,
      });
      if (!resolvedRef.ok) {
        if (resolvedRef.code === 'not_found') {
          res.json({ ok: true });
          return;
        }
        sendApiError(res, resolvedRef.code, resolvedRef.message);
        return;
      }
      await deleteRefPath(resolvedRef.path);
      res.json({ ok: true });
    } catch (error: unknown) {
      sendUnexpectedApiError(res, logContext, error);
    }
  });
}
