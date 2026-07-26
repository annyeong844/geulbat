import { Router } from 'express';

import { isRecord } from '../../../daemon/runtime-json.js';
import { sendApiError } from '#web/response/send-api-error.js';

type QwenTokenPlanRegion = 'global' | 'china';
interface QwenTokenPlanCredential {
  apiKey: string;
  region: QwenTokenPlanRegion;
}
type QwenTokenPlanConnectionStatus =
  | { state: 'missing'; region: QwenTokenPlanRegion; baseUrl: string }
  | {
      state: 'ready';
      source: 'environment' | 'stored';
      region: QwenTokenPlanRegion;
      baseUrl: string;
    };

interface QwenTokenPlanRouteDependencies {
  getStatus: () => Promise<QwenTokenPlanConnectionStatus>;
  writeCredential: (credential: QwenTokenPlanCredential) => Promise<void>;
  deleteCredential: () => Promise<void>;
}

export function createQwenTokenPlanRoutes(
  dependencies: QwenTokenPlanRouteDependencies,
): Router {
  const router = Router();

  router.get('/api/qwen-token-plan/status', async (_req, res) => {
    res.json(await dependencies.getStatus());
  });

  router.post('/api/qwen-token-plan/connect', async (req, res) => {
    const credential = readConnectCredential(req.body);
    if (credential === null) {
      sendApiError(
        res,
        'bad_request',
        'apiKey and a supported region are required',
      );
      return;
    }
    const current = await dependencies.getStatus();
    if (current.state === 'ready' && current.source === 'environment') {
      sendApiError(
        res,
        'conflict',
        'Qwen Token Plan is managed by the environment.',
      );
      return;
    }

    await dependencies.writeCredential(credential);
    res.json(await dependencies.getStatus());
  });

  router.post('/api/qwen-token-plan/disconnect', async (_req, res) => {
    const current = await dependencies.getStatus();
    if (current.state === 'ready' && current.source === 'environment') {
      sendApiError(
        res,
        'conflict',
        'Environment-managed Qwen Token Plan credentials cannot be removed here.',
      );
      return;
    }

    await dependencies.deleteCredential();
    res.json({ ok: true });
  });

  return router;
}

function readConnectCredential(body: unknown): QwenTokenPlanCredential | null {
  if (!isRecord(body) || Object.keys(body).length !== 2) {
    return null;
  }
  const apiKey = body['apiKey'];
  const region = body['region'];
  if (
    typeof apiKey !== 'string' ||
    apiKey.trim() === '' ||
    (region !== 'global' && region !== 'china')
  ) {
    return null;
  }
  return { apiKey: apiKey.trim(), region };
}
