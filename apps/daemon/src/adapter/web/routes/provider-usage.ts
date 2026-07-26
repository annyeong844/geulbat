import { Router } from 'express';

import type { ProviderUsageResponse } from '@geulbat/protocol/provider-usage';
import {
  fetchProviderUsage,
  type ProviderUsageFetchDeps,
} from '../../../daemon/provider-usage.js';
import { sendUnexpectedApiError } from '#web/response/send-api-error.js';

/**
 * 제공자가 보고하는 사용량. 값의 소유자는 제공자이므로 영속 사본을 두지 않고,
 * 조회 결과는 짧은 캐시만 거친다. `?refresh=1`은 그 캐시를 건너뛴다.
 */
export function createProviderUsageRoutes(args: {
  loadCredential: ProviderUsageFetchDeps['loadCredential'];
}): Router {
  const router = Router();

  router.get('/api/provider-usage', async (req, res) => {
    const forceRefresh = req.query['refresh'] === '1';
    try {
      const providers = await fetchProviderUsage({
        loadCredential: args.loadCredential,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
      res.status(200).json({ providers } satisfies ProviderUsageResponse);
    } catch (error: unknown) {
      sendUnexpectedApiError(res, 'api/provider-usage', error);
    }
  });

  return router;
}
