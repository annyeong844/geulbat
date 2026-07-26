import {
  resolveProviderAuthCredentialProviderId,
  type ProviderAuthCredentialProviderId,
  type ProviderCredential,
} from './credentials/store.js';
import { refreshProviderCredential } from './credentials/refresh.js';
import type { ProviderAuthRuntimeStore } from './runtime-state.js';
import { PROVIDER_AUTH_REFRESH_MARGIN_MS } from './bootstrap/config.js';
import type { ErrorCode } from '../error-codes.js';
import { getGenericApiErrorCode, getErrorMessage } from '../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { initProviderAuth } from './init.js';
import { requiresProviderReconnect } from './shared.js';
import { runDetached } from '../utils/run-detached.js';

const logger = createLogger('provider-auth');

/**
 * Return a valid provider token for API calls.
 * Auto-refreshes when the token is within REFRESH_MARGIN_MS of expiry.
 * Concurrent callers share the same in-flight refresh promise (mutex).
 */
export async function getProviderAuth(options: {
  allowRefresh?: boolean;
  onWait?: () => void;
  providerId?: ProviderAuthCredentialProviderId;
  refreshCredential?: (
    current: ProviderCredential,
  ) => Promise<ProviderCredential>;
  persistCredential?: (credential: ProviderCredential) => Promise<void>;
  runtimeStore: ProviderAuthRuntimeStore;
  signal?: AbortSignal;
}): Promise<{ accessToken: string; accountId: string }> {
  const { runtimeStore } = options;
  const providerId = resolveProviderAuthCredentialProviderId(
    options.providerId,
  );
  if (!runtimeStore.hasHydratedProviderAuth(providerId)) {
    await initProviderAuth({ runtimeStore, providerId });
  }
  let cached = runtimeStore.getCachedProviderCredential(providerId);
  if (!cached) {
    throwProviderAuthFailure(
      runtimeStore.getCachedProviderAuthLoadError(providerId) ?? {
        code: 'provider_auth_session_not_found',
        message: 'No provider credentials available.',
      },
    );
  }
  const existingRefreshError =
    runtimeStore.getCachedProviderAuthRefreshError(providerId);
  if (existingRefreshError && requiresProviderReconnect(existingRefreshError)) {
    throwProviderAuthFailure(existingRefreshError);
  }

  const { allowRefresh = true } = options;
  const shouldRefresh =
    cached.expiresAt > 0 &&
    cached.expiresAt - Date.now() < PROVIDER_AUTH_REFRESH_MARGIN_MS;

  if (shouldRefresh && allowRefresh) {
    await doRefresh({
      providerId,
      runtimeStore,
      ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
      ...(options.refreshCredential !== undefined
        ? { refreshCredential: options.refreshCredential }
        : {}),
      ...(options.persistCredential !== undefined
        ? { persistCredential: options.persistCredential }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    cached = runtimeStore.getCachedProviderCredential(providerId);
    if (!cached) {
      throwProviderAuthFailure(
        runtimeStore.getCachedProviderAuthLoadError(providerId) ?? {
          code: 'provider_auth_session_not_found',
          message: 'No provider credentials available.',
        },
      );
    }
    const refreshError =
      runtimeStore.getCachedProviderAuthRefreshError(providerId);
    if (refreshError && requiresProviderReconnect(refreshError)) {
      throwProviderAuthFailure(refreshError);
    }
  }

  return {
    accessToken: cached.accessToken,
    accountId: cached.accountId,
  };
}

export async function forceRefreshProviderAuth(options: {
  onWait?: () => void;
  providerId?: ProviderAuthCredentialProviderId;
  refreshCredential?: (
    current: ProviderCredential,
  ) => Promise<ProviderCredential>;
  persistCredential?: (credential: ProviderCredential) => Promise<void>;
  runtimeStore: ProviderAuthRuntimeStore;
  signal?: AbortSignal;
}): Promise<{ accessToken: string; accountId: string }> {
  const { runtimeStore } = options;
  const providerId = resolveProviderAuthCredentialProviderId(
    options.providerId,
  );
  if (!runtimeStore.hasHydratedProviderAuth(providerId)) {
    await initProviderAuth({ runtimeStore, providerId });
  }

  const cached = runtimeStore.getCachedProviderCredential(providerId);
  if (!cached) {
    throwProviderAuthFailure(
      runtimeStore.getCachedProviderAuthLoadError(providerId) ?? {
        code: 'provider_auth_session_not_found',
        message: 'No provider credentials available.',
      },
    );
  }

  await doRefresh({
    providerId,
    runtimeStore,
    ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
    ...(options.refreshCredential !== undefined
      ? { refreshCredential: options.refreshCredential }
      : {}),
    ...(options.persistCredential !== undefined
      ? { persistCredential: options.persistCredential }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  const refreshError =
    runtimeStore.getCachedProviderAuthRefreshError(providerId);
  if (refreshError) {
    throwProviderAuthFailure(refreshError);
  }

  const refreshed = runtimeStore.getCachedProviderCredential(providerId);
  if (!refreshed) {
    throwProviderAuthFailure({
      code: 'provider_auth_session_not_found',
      message: 'No provider credentials available.',
    });
  }

  return {
    accessToken: refreshed.accessToken,
    accountId: refreshed.accountId,
  };
}

/** Refresh mutex — concurrent callers await the same promise. */
async function doRefresh(options: {
  onWait?: () => void;
  providerId: ProviderAuthCredentialProviderId;
  refreshCredential?: (
    current: ProviderCredential,
  ) => Promise<ProviderCredential>;
  persistCredential?: (credential: ProviderCredential) => Promise<void>;
  runtimeStore: ProviderAuthRuntimeStore;
  signal?: AbortSignal;
}): Promise<void> {
  const { providerId, runtimeStore } = options;
  throwIfProviderAuthWaitAborted(options.signal);
  const currentRefreshPromise =
    runtimeStore.getProviderAuthRefreshPromise(providerId);
  if (currentRefreshPromise) {
    options.onWait?.();
    await waitForProviderAuthRefresh(currentRefreshPromise, options.signal);
    return;
  }

  options.onWait?.();
  const refreshCredential =
    options.refreshCredential ??
    ((current: ProviderCredential) =>
      refreshProviderCredential(providerId, current));
  const persistCredential =
    options?.persistCredential ??
    ((credential) =>
      runtimeStore.persistProviderCredential(credential, providerId));
  const refreshPromise = (async () => {
    try {
      const current = runtimeStore.getCachedProviderCredential(providerId);
      if (!current) {
        return;
      }
      const refreshed = await refreshCredential(current);
      await persistCredential(refreshed);
      runtimeStore.setCachedProviderAuthRefreshError(null, providerId);
      logger.info('Token refreshed');
    } catch (err: unknown) {
      const code =
        getGenericApiErrorCode(err) ?? 'provider_auth_refresh_failed';
      const message =
        code === 'provider_auth_invalid'
          ? getErrorMessage(err)
          : `Provider token refresh failed. ${getErrorMessage(err)}`;
      runtimeStore.setCachedProviderAuthRefreshError(
        {
          code,
          message,
        },
        providerId,
      );
      logger.error('Token refresh failed:', message);
      // Keep existing token — caller may still succeed; 401 handled upstream
    }
  })();
  runtimeStore.setProviderAuthRefreshPromise(refreshPromise, providerId);

  const clearRefreshPromise = () => {
    if (
      runtimeStore.getProviderAuthRefreshPromise(providerId) === refreshPromise
    ) {
      runtimeStore.setProviderAuthRefreshPromise(null, providerId);
    }
  };
  runDetached('auth/provider-refresh-cleanup', () =>
    refreshPromise.then(clearRefreshPromise, clearRefreshPromise),
  );
  await waitForProviderAuthRefresh(refreshPromise, options.signal);
}

function waitForProviderAuthRefresh(
  refreshPromise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    return refreshPromise;
  }
  throwIfProviderAuthWaitAborted(signal);

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createProviderAuthWaitAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    runDetached('auth/provider-refresh-wait', () =>
      refreshPromise.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(
            error instanceof Error
              ? error
              : new Error('provider auth refresh failed', { cause: error }),
          );
        },
      ),
    );
  });
}

function throwIfProviderAuthWaitAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw createProviderAuthWaitAbortError(signal.reason);
  }
}

function createProviderAuthWaitAbortError(reason: unknown): Error {
  const error = new Error('provider auth wait aborted', { cause: reason });
  error.name = 'AbortError';
  return error;
}

function throwProviderAuthFailure(error: {
  code?: ErrorCode;
  message: string;
}): never {
  throw Object.assign(new Error(error.message), {
    ...(error.code !== undefined ? { code: error.code } : {}),
    llmCode: 'llm_auth_failed',
  });
}
