import { Router } from 'express';
import { z } from 'zod';

import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionModeState,
} from '@geulbat/protocol/run-approval';
import {
  PermissionModeStoreCorruptError,
  readPermissionModeState,
  writePermissionModeState,
} from '../../../daemon/permission-mode-store.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

const updateSchema = z
  .object({ permissionMode: z.enum(PERMISSION_MODES) })
  .strict();

export function createPermissionModeRoutes(args: {
  homeStateRoot: string;
}): Router {
  const router = Router();

  router.get('/api/permission-mode', async (_req, res) => {
    try {
      const state = await readPermissionModeState(args.homeStateRoot);
      res.status(200).json(state satisfies PermissionModeState);
    } catch (error: unknown) {
      if (error instanceof PermissionModeStoreCorruptError) {
        // 손상된 문서를 조용히 basic으로 덮지 않는다. 클라이언트는 안전한 모드로
        // 남고, 사용자는 어느 파일을 고쳐야 하는지 듣는다.
        sendApiError(
          res,
          'internal',
          `stored permission mode is unreadable; delete or repair ${error.filePath} to continue`,
          { permissionMode: DEFAULT_PERMISSION_MODE },
        );
        return;
      }
      sendUnexpectedApiError(res, 'api/permission-mode', error);
    }
  });

  router.put('/api/permission-mode', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 'bad_request', 'invalid permission mode request');
      return;
    }
    try {
      const state = await writePermissionModeState(
        args.homeStateRoot,
        parsed.data.permissionMode,
      );
      res.status(200).json(state satisfies PermissionModeState);
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'api/permission-mode', error);
    }
  });

  return router;
}
