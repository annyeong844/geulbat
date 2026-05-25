import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';
import type { ErrorCode } from '@geulbat/protocol/errors';

import type {
  PendingProviderAuthSession,
  ProviderAuthBootstrapStore,
} from './bootstrap/session-store.js';
import {
  isProviderAuthConfigured,
  MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE,
  PROVIDER_AUTH_NOT_CONFIGURED_CODE,
  PROVIDER_AUTH_POLL_AFTER_MS,
  PROVIDER_AUTH_REFRESH_MARGIN_MS,
} from './bootstrap/config.js';
import type { ProviderCredential } from './credentials/store.js';
import { deleteProviderAuthFile } from './credentials/store.js';
import type { ProviderAuthRuntimeStore } from './runtime-state.js';
import {
  EXPIRED_PROVIDER_CREDENTIAL_MESSAGE,
  isProviderCredentialUsable,
  requiresProviderReconnect,
  type ProviderAuthStatus,
} from './shared.js';
import { initProviderAuth } from './init.js';

/** Read-only status snapshot. Never triggers refresh or disk writes. */
export async function getProviderAuthStatus(options: {
  readCredential?: () => Promise<ProviderCredential | null>;
  runtimeStore: ProviderAuthRuntimeStore;
}): Promise<ProviderAuthStatus> {
  const { runtimeStore } = options;
  if (!runtimeStore.hasHydratedProviderAuth()) {
    await initProviderAuth({
      runtimeStore,
      ...(options.readCredential !== undefined
        ? { readCredential: options.readCredential }
        : {}),
    });
  }
  const cached = runtimeStore.getCachedProviderCredential();

  if (!cached) {
    return {
      ready: false,
      source: 'missing',
      refreshInFlight: runtimeStore.getProviderAuthRefreshPromise() !== null,
    };
  }

  const now = Date.now();
  const expiresInMs = cached.expiresAt > 0 ? cached.expiresAt - now : undefined;

  return {
    ready: true,
    source: 'file',
    refreshRecommended:
      expiresInMs !== undefined &&
      expiresInMs < PROVIDER_AUTH_REFRESH_MARGIN_MS,
    refreshInFlight: runtimeStore.getProviderAuthRefreshPromise() !== null,
    ...(cached.expiresAt > 0 ? { expiresAt: cached.expiresAt } : {}),
    ...(expiresInMs !== undefined ? { expiresInMs } : {}),
  };
}

export async function getProviderBootstrapStatus(options: {
  readCredential?: () => Promise<ProviderCredential | null>;
  runtimeStore: ProviderAuthRuntimeStore;
  bootstrapStore: ProviderAuthBootstrapStore;
}): Promise<ProviderAuthStatusResponse> {
  const { runtimeStore, bootstrapStore } = options;
  if (!runtimeStore.hasHydratedProviderAuth()) {
    await initProviderAuth({
      runtimeStore,
      ...(options.readCredential !== undefined
        ? { readCredential: options.readCredential }
        : {}),
    });
  }

  const cachedLoadError = runtimeStore.getCachedProviderAuthLoadError();
  const cachedRefreshError = runtimeStore.getCachedProviderAuthRefreshError();
  if (cachedLoadError) {
    return {
      state: 'exchange_failed',
      lastErrorCode: cachedLoadError.code,
      lastErrorMessage: cachedLoadError.message,
      ready: false,
    };
  }

  const cached = runtimeStore.getCachedProviderCredential();
  if (
    cached &&
    cachedRefreshError &&
    requiresProviderReconnect(cachedRefreshError)
  ) {
    return {
      state: 'expired',
      lastErrorCode: cachedRefreshError.code,
      lastErrorMessage: cachedRefreshError.message,
      ready: false,
      ...(cached.expiresAt > 0 ? { expiresAt: cached.expiresAt } : {}),
    };
  }
  const isExpiredOnClock =
    cached !== null && cached.expiresAt > 0 && cached.expiresAt <= Date.now();
  if (cached && cachedRefreshError && isExpiredOnClock) {
    return {
      state: 'expired',
      lastErrorCode: cachedRefreshError.code,
      lastErrorMessage: cachedRefreshError.message,
      ready: false,
      expiresAt: cached.expiresAt,
    };
  }

  const cachedExpiresAt = cached?.expiresAt || undefined;
  const hasUsableCredential =
    cached !== null && isProviderCredentialUsable(cached);

  if (hasUsableCredential && cached) {
    if (cachedRefreshError) {
      return {
        state: 'ready',
        ready: true,
        ...(cachedExpiresAt !== undefined
          ? { expiresAt: cachedExpiresAt }
          : {}),
        lastErrorCode: cachedRefreshError.code,
        lastErrorMessage: cachedRefreshError.message,
      };
    }

    return {
      state: 'ready',
      ready: true,
      ...(cachedExpiresAt !== undefined ? { expiresAt: cachedExpiresAt } : {}),
    };
  }

  if (!(await isProviderAuthConfigured())) {
    return {
      state: 'exchange_failed',
      lastErrorCode: PROVIDER_AUTH_NOT_CONFIGURED_CODE,
      lastErrorMessage: MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE,
      ready: false,
    };
  }

  if (cached) {
    return {
      state: 'expired',
      lastErrorCode:
        cachedRefreshError?.code ?? 'provider_auth_session_expired',
      lastErrorMessage:
        cachedRefreshError?.message ?? EXPIRED_PROVIDER_CREDENTIAL_MESSAGE,
      ready: false,
      ...(cachedExpiresAt !== undefined ? { expiresAt: cachedExpiresAt } : {}),
    };
  }

  const session = bootstrapStore.getProviderAuthSessionSnapshot();
  if (!session) {
    return {
      state: 'missing',
      ready: false,
    };
  }

  switch (session.status) {
    case 'pending':
      return {
        state: 'pending',
        authSessionId: session.authSessionId,
        expiresAt: session.expiresAt,
        pollAfterMs: PROVIDER_AUTH_POLL_AFTER_MS,
        ready: false,
      };
    case 'ready':
      return {
        state: 'ready',
        authSessionId: session.authSessionId,
        expiresAt: session.expiresAt,
        ready: false,
      };
    case 'exchange_failed':
      return {
        state: 'exchange_failed',
        authSessionId: session.authSessionId,
        expiresAt: session.expiresAt,
        ...readTerminalProviderAuthSessionError(session),
        ready: false,
      };
    case 'expired':
      return {
        state: 'expired',
        authSessionId: session.authSessionId,
        expiresAt: session.expiresAt,
        ...readTerminalProviderAuthSessionError(session),
        ready: false,
      };
  }
}

export async function loadCurrentProviderCredential(options: {
  runtimeStore: ProviderAuthRuntimeStore;
  readCredential?: () => Promise<ProviderCredential | null>;
}): Promise<ProviderCredential | null> {
  const { runtimeStore } = options;
  if (!runtimeStore.hasHydratedProviderAuth()) {
    await initProviderAuth({
      runtimeStore,
      ...(options.readCredential !== undefined
        ? { readCredential: options.readCredential }
        : {}),
    });
  }
  return runtimeStore.getCachedProviderCredential();
}

export async function logoutProviderAuth(options: {
  runtimeStore: ProviderAuthRuntimeStore;
  bootstrapStore: ProviderAuthBootstrapStore;
}): Promise<void> {
  const { runtimeStore, bootstrapStore } = options;
  await deleteProviderAuthFile();
  runtimeStore.clearProviderAuthRuntimeState();
  bootstrapStore.clearProviderAuthBootstrapState();
}

function readTerminalProviderAuthSessionError(
  session: PendingProviderAuthSession,
): {
  lastErrorCode: ErrorCode;
  lastErrorMessage: string;
} {
  if (!session.lastErrorCode || !session.lastErrorMessage) {
    throw new Error(
      `provider auth ${session.status} session is missing terminal error fields`,
    );
  }

  return {
    lastErrorCode: session.lastErrorCode,
    lastErrorMessage: session.lastErrorMessage,
  };
}
