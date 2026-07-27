import { Router } from 'express';

import { isRecord } from '../../../daemon/runtime-json.js';
import type {
  PtcCallbackTransportPolicy,
  PtcCallbackTransportSettingsPort,
} from '../../../daemon/ptc-callback-transport-settings.js';
import { sendApiError } from '#web/response/send-api-error.js';

// PTC transition spec v7 §3 (2026-07-27) — 운영자가 콜백 전송 정책을 확정하는 표면.
// Qwen Token Plan 라우트와 같은 규범을 쓴다: 환경이 관리 중이면 브라우저에서 바꾸거나
// 지울 수 없고, 그 사실을 상태로 알려 준다. 값을 서버가 지어내지 않으므로 enable은
// 다섯 한도를 모두 받는다 — 부분 입력은 저장 전에 거부한다.

const POLICY_FIELDS = [
  'maxFrameBytes',
  'maxOpenConnections',
  'maxCallbacks',
  'callbackTimeoutMs',
  'maxResponseBytes',
] as const;

export function createPtcCallbackTransportRoutes(
  dependencies: PtcCallbackTransportSettingsPort,
): Router {
  const router = Router();

  router.get('/api/ptc-callback-transport/status', async (_req, res) => {
    res.json(await dependencies.getStatus());
  });

  router.post('/api/ptc-callback-transport/enable', async (req, res) => {
    const policy = readPolicyInput(req.body);
    if (policy === null) {
      sendApiError(
        res,
        'bad_request',
        'every callback transport limit is required as a positive integer',
      );
      return;
    }
    const current = await dependencies.getStatus();
    if (current.state === 'ready' && current.source === 'environment') {
      sendApiError(
        res,
        'conflict',
        'PTC callback transport limits are managed by the environment.',
      );
      return;
    }

    await dependencies.savePolicy(policy);
    res.json(await dependencies.getStatus());
  });

  router.post('/api/ptc-callback-transport/disable', async (_req, res) => {
    const current = await dependencies.getStatus();
    if (current.state === 'ready' && current.source === 'environment') {
      sendApiError(
        res,
        'conflict',
        'Environment-managed PTC callback transport limits cannot be removed here.',
      );
      return;
    }

    await dependencies.clearPolicy();
    res.json(await dependencies.getStatus());
  });

  return router;
}

function readPolicyInput(body: unknown): PtcCallbackTransportPolicy | null {
  if (!isRecord(body) || Object.keys(body).length !== POLICY_FIELDS.length) {
    return null;
  }
  const limits: number[] = [];
  for (const field of POLICY_FIELDS) {
    const candidate = body[field];
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate <= 0
    ) {
      return null;
    }
    limits.push(candidate);
  }
  const [
    maxFrameBytes,
    maxOpenConnections,
    maxCallbacks,
    callbackTimeoutMs,
    maxResponseBytes,
  ] = limits as [number, number, number, number, number];
  return {
    maxFrameBytes,
    maxOpenConnections,
    maxCallbacks,
    callbackTimeoutMs,
    maxResponseBytes,
  };
}
