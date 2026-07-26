import { Router } from 'express';
import { z } from 'zod';

import type { DirectoryPreferencesResponse } from '@geulbat/protocol/files';
import {
  applyDirectoryPreference,
  readDirectoryPreferences,
} from '../../../daemon/directory-preferences-store.js';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

const actionSchema = z
  .object({
    action: z.enum(['select', 'pin', 'unpin']),
    path: z.string().min(1),
  })
  .strict();

/**
 * 어디서 일하는지에 대한 사용자 선택. daemon이 소유하므로 daemon이 죽거나
 * 브라우저를 새로 열어도 남는다.
 */
export function createDirectoryPreferencesRoutes(args: {
  homeStateRoot: string;
  /** 자동 발견 경로. 조회 시점에 읽는다 — 탐색으로 늘어날 수 있다. */
  listDefaultPaths: () => readonly string[];
}): Router {
  const router = Router();

  const project = (
    preferences: DirectoryPreferencesResponse,
  ): DirectoryPreferencesResponse => {
    const defaults = new Set(args.listDefaultPaths());
    return {
      workingDirectory: preferences.workingDirectory,
      favorites: preferences.favorites,
      // 자동 발견 경로는 선택기가 이미 자기 항목으로 보여준다.
      recents: preferences.recents.filter((entry) => !defaults.has(entry.path)),
    };
  };

  router.get('/api/files/directory-preferences', async (_req, res) => {
    try {
      res
        .status(200)
        .json(project(await readDirectoryPreferences(args.homeStateRoot)));
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'api/files/directory-preferences', error);
    }
  });

  router.post('/api/files/directory-preferences', async (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 'bad_request', 'invalid directory preference action');
      return;
    }
    try {
      const preferences = await applyDirectoryPreference({
        homeStateRoot: args.homeStateRoot,
        action: { kind: parsed.data.action, path: parsed.data.path },
        excludedPaths: args.listDefaultPaths(),
      });
      res.status(200).json(project(preferences));
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'api/files/directory-preferences', error);
    }
  });

  return router;
}
