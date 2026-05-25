import type {
  ProviderAuthLogoutResponse,
  ProviderAuthStartRequest,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';
import { Router } from 'express';

import {
  completeProviderAuthCallback,
  normalizeProviderAuthCallbackQueryParam,
} from '../../../daemon/auth/bootstrap/callback.js';
import { failurePage } from '../../../daemon/auth/bootstrap/callback-page.js';
import type { ProviderAuthCallbackServerController } from '../../../daemon/auth/bootstrap/callback-server.js';
import {
  getRequiredProviderAuthClientId,
  PROVIDER_AUTH_REVOCATION_URL,
} from '../../../daemon/auth/bootstrap/config.js';
import {
  getProviderBootstrapStatus,
  loadCurrentProviderCredential,
  logoutProviderAuth,
} from '../../../daemon/auth/status.js';
import { startProviderAuthLogin } from '../../../daemon/auth/bootstrap/start-login.js';
import type { ProviderAuthBootstrapStore } from '../../../daemon/auth/bootstrap/session-store.js';
import type { ProviderAuthRuntimeStore } from '../../../daemon/auth/runtime-state.js';
import {
  getAppErrorCode,
  getErrorMessage,
} from '../../../daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { ProviderAuthRoutesContext } from './routes-context.js';
import { requireAuth } from '#web/auth/require-auth.js';
import { sendApiError } from '#web/response/send-api-error.js';

const logger = createLogger('provider-auth');

export function createProviderAuthRoutes(args: {
  context: ProviderAuthRoutesContext;
}): Router {
  const {
    providerAuthBootstrap: bootstrapStore,
    providerAuthCallbackServer: callbackServer,
    providerAuthRuntime: runtimeStore,
  } = args.context;
  return createProviderAuthRoutesInternal({
    bootstrapStore,
    callbackServer,
    runtimeStore,
  });
}

function createProviderAuthRoutesInternal(args: {
  bootstrapStore: ProviderAuthBootstrapStore;
  callbackServer: ProviderAuthCallbackServerController;
  runtimeStore: ProviderAuthRuntimeStore;
}): Router {
  const router = Router();
  const { bootstrapStore, callbackServer, runtimeStore } = args;

  router.get('/api/provider-auth/callback', async (req, res) => {
    try {
      const code = normalizeProviderAuthCallbackQueryParam(req.query['code']);
      const state = normalizeProviderAuthCallbackQueryParam(req.query['state']);
      const error = normalizeProviderAuthCallbackQueryParam(req.query['error']);
      const errorDescription = normalizeProviderAuthCallbackQueryParam(
        req.query['error_description'],
      );
      const result = await completeProviderAuthCallback(
        {
          ...(code !== undefined ? { code } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(errorDescription !== undefined ? { errorDescription } : {}),
        },
        { bootstrapStore, runtimeStore },
      );

      res.status(result.statusCode);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(result.html);
    } catch (err: unknown) {
      logger.error('callback failed:', getErrorMessage(err));
      const fallback = failurePage(
        500,
        'Provider login failed',
        'Internal server error.',
      );
      res.status(fallback.statusCode);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(fallback.html);
    }
  });

  router.post('/api/provider-auth/start', requireAuth, async (req, res) => {
    const body = req.body as ProviderAuthStartRequest | undefined;
    const launcher = body?.launcher;

    if (launcher !== 'web-shell') {
      sendApiError(res, 'bad_request', 'launcher must be "web-shell"');
      return;
    }

    const status = await getProviderBootstrapStatus({
      bootstrapStore,
      runtimeStore,
    });
    if (status.ready) {
      sendApiError(
        res,
        'provider_auth_already_connected',
        'Provider auth is already connected.',
      );
      return;
    }

    try {
      const response = await startProviderAuthLogin({
        bootstrapStore,
        ensureCallbackServer: () => callbackServer.ensureListening(),
      });
      res.json(response);
    } catch (err: unknown) {
      logger.warn('start failed:', getErrorMessage(err));
      const { code, message } = normalizeProviderAuthStartError(err);
      sendApiError(res, code, message);
    }
  });

  router.get('/api/provider-auth/status', requireAuth, async (_req, res) => {
    const status = await getProviderBootstrapStatus({
      bootstrapStore,
      runtimeStore,
    });
    res.json(status satisfies ProviderAuthStatusResponse);
  });

  router.post('/api/provider-auth/logout', requireAuth, async (_req, res) => {
    try {
      const credential = await loadCurrentProviderCredential({ runtimeStore });
      if (credential && PROVIDER_AUTH_REVOCATION_URL) {
        await revokeProviderToken(
          credential.refreshToken || credential.accessToken,
        );
      }
    } catch (err: unknown) {
      logger.warn('revoke failed:', getErrorMessage(err));
    }

    await logoutProviderAuth({ bootstrapStore, runtimeStore });
    res.json({ ok: true } satisfies ProviderAuthLogoutResponse);
  });

  return router;
}

async function revokeProviderToken(token: string): Promise<void> {
  if (!PROVIDER_AUTH_REVOCATION_URL || !token) {
    return;
  }
  const clientId = await getRequiredProviderAuthClientId();

  const res = await fetch(PROVIDER_AUTH_REVOCATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      token,
    }),
  });

  if (!res.ok) {
    throw new Error(`Provider revocation failed (${res.status})`);
  }
}

function normalizeProviderAuthStartError(error: unknown): {
  code:
    | 'provider_auth_not_configured'
    | 'provider_auth_callback_unavailable'
    | 'provider_auth_exchange_failed';
  message: string;
} {
  const code = getAppErrorCode(error);
  if (code === 'provider_auth_not_configured') {
    return {
      code,
      message:
        error instanceof Error
          ? error.message
          : 'Provider auth is not configured.',
    };
  }
  if (code === 'provider_auth_callback_unavailable') {
    return {
      code,
      message:
        error instanceof Error
          ? error.message
          : 'Provider auth callback listener is unavailable.',
    };
  }
  return {
    code: 'provider_auth_exchange_failed',
    message: 'Failed to initialize provider auth login.',
  };
}
