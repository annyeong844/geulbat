import type { RequestHandler } from 'express';
import {
  INVALID_DEV_TOKEN_MESSAGE,
  isAuthorizedShellHeaders,
} from './shell-auth.js';
import {
  clearShellAuthFailures,
  recordShellAuthFailure,
} from './auth-failure-rate-limit.js';
import { sendApiError } from '#web/response/send-api-error.js';

/**
 * Dev token for Phase 1 local-first auth.
 * Set via GEULBAT_DEV_TOKEN env var. No default fallback.
 * Accepts the explicit X-Geulbat-Dev-Token header or the HttpOnly same-origin
 * shell session cookie. Browser-native media requests and websocket upgrades
 * cannot attach the explicit header, and the current product policy grants
 * browser-native shell requests the shell API authority. Artifact runtime
 * frames are opaque-origin and must use the mediated postMessage bridge.
 *
 * This is shell-daemon API auth only.
 * daemon-provider auth (LLM credentials) is a separate layer.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!isAuthorizedShellHeaders(req.headers)) {
    const result = recordShellAuthFailure(req.ip ?? req.socket.remoteAddress);
    if (result.limited) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      sendApiError(
        res,
        'rate_limited',
        'too many authentication failures; retry later',
      );
      return;
    }
    sendApiError(res, 'unauthorized', INVALID_DEV_TOKEN_MESSAGE);
    return;
  }
  clearShellAuthFailures(req.ip ?? req.socket.remoteAddress);
  next();
};
