import type { ErrorCode } from '../contract.js';
import { errorCodeToStatus } from '../../error-codes.js';

import { deriveProviderAccountId } from './account-id.js';
import {
  sanitizeProviderAuthMessage,
  type PendingProviderAuthSession,
  type ProviderAuthBootstrapStore,
} from './session-store.js';
import type {
  ProviderAuthCredentialProviderId,
  ProviderCredential,
} from '../credentials/store.js';
import type { ProviderAuthRuntimeStore } from '../runtime-state.js';
import {
  exchangeAuthorizationCode,
  extractProviderAuthErrorCode,
} from './callback-exchange.js';
import { failurePage, successPage } from './callback-page.js';

export interface ProviderAuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface ProviderAuthCallbackResult {
  html: string;
  statusCode: number;
}

type ProviderAuthExchangeFn = (
  code: string,
  codeVerifier: string,
  options: { providerId: ProviderAuthCredentialProviderId },
) => ReturnType<typeof exchangeAuthorizationCode>;

type ProviderAuthTokenResponse = Awaited<
  ReturnType<typeof exchangeAuthorizationCode>
>;

export function normalizeProviderAuthCallbackQueryParam(
  value: unknown,
): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function completeProviderAuthCallback(
  query: ProviderAuthCallbackQuery,
  options: {
    bootstrapStore: ProviderAuthBootstrapStore;
    runtimeStore: ProviderAuthRuntimeStore;
    exchangeCode?: ProviderAuthExchangeFn;
  },
): Promise<ProviderAuthCallbackResult> {
  const { bootstrapStore, runtimeStore } = options;
  const exchangeCode = options?.exchangeCode ?? exchangeAuthorizationCode;
  const sessionResult = resolveProviderAuthCallbackSession({
    query,
    bootstrapStore,
  });
  if (!sessionResult.ok) {
    return sessionResult.result;
  }

  const codeResult = readProviderAuthCallbackCode({
    query,
    session: sessionResult.session,
    bootstrapStore,
  });
  if (!codeResult.ok) {
    return codeResult.result;
  }

  const consumedResult = consumeProviderAuthCallbackSession({
    session: sessionResult.session,
    bootstrapStore,
  });
  if (!consumedResult.ok) {
    return consumedResult.result;
  }

  return await exchangeAndPersistProviderCredential({
    code: codeResult.code,
    codeVerifier: consumedResult.session.codeVerifier,
    authSessionId: sessionResult.session.authSessionId,
    providerId: consumedResult.session.providerId,
    bootstrapStore,
    runtimeStore,
    exchangeCode,
  });
}

function resolveProviderAuthCallbackSession(args: {
  query: ProviderAuthCallbackQuery;
  bootstrapStore: ProviderAuthBootstrapStore;
}):
  | { ok: true; session: PendingProviderAuthSession }
  | { ok: false; result: ProviderAuthCallbackResult } {
  const { query, bootstrapStore } = args;
  const state = query.state?.trim();
  const session = state
    ? bootstrapStore.getProviderAuthSessionSnapshotByState(state)
    : null;
  const providerErrorResult = handleProviderCallbackError({
    query,
    session,
    bootstrapStore,
  });
  if (providerErrorResult) {
    return { ok: false, result: providerErrorResult };
  }

  if (!state) {
    return {
      ok: false,
      result: failurePage(
        400,
        'Provider login failed',
        'Missing callback state.',
      ),
    };
  }

  if (!session) {
    return {
      ok: false,
      result: failurePage(
        404,
        'Provider login failed',
        'Provider auth session was not found.',
      ),
    };
  }

  if (
    session.status !== 'pending' ||
    session.expiresAt <= Date.now() ||
    session.consumedAt
  ) {
    bootstrapStore.markProviderAuthSessionExpired(
      session.authSessionId,
      'The provider login session is expired or already used.',
    );
    return {
      ok: false,
      result: failurePage(
        410,
        'Provider login failed',
        'Provider auth session has expired.',
      ),
    };
  }

  return { ok: true, session };
}

function handleProviderCallbackError(args: {
  query: ProviderAuthCallbackQuery;
  session: PendingProviderAuthSession | null;
  bootstrapStore: ProviderAuthBootstrapStore;
}): ProviderAuthCallbackResult | null {
  const { query, session, bootstrapStore } = args;
  if (!query.error) {
    return null;
  }

  const message = query.errorDescription || query.error;
  if (session) {
    bootstrapStore.markProviderAuthSessionFailure(
      session.authSessionId,
      'provider_auth_exchange_failed',
      message,
    );
  }
  return failurePage(
    502,
    'Provider login failed',
    sanitizeProviderAuthMessage(message),
  );
}

function readProviderAuthCallbackCode(args: {
  query: ProviderAuthCallbackQuery;
  session: PendingProviderAuthSession;
  bootstrapStore: ProviderAuthBootstrapStore;
}):
  | { ok: true; code: string }
  | { ok: false; result: ProviderAuthCallbackResult } {
  const { query, session, bootstrapStore } = args;
  const code = query.code?.trim();
  if (code) {
    return { ok: true, code };
  }

  bootstrapStore.markProviderAuthSessionFailure(
    session.authSessionId,
    'provider_auth_exchange_failed',
    'Missing authorization code.',
  );
  return {
    ok: false,
    result: failurePage(
      400,
      'Provider login failed',
      'Missing authorization code.',
    ),
  };
}

function consumeProviderAuthCallbackSession(args: {
  session: PendingProviderAuthSession;
  bootstrapStore: ProviderAuthBootstrapStore;
}):
  | { ok: true; session: PendingProviderAuthSession }
  | { ok: false; result: ProviderAuthCallbackResult } {
  const { session, bootstrapStore } = args;
  const consumed = bootstrapStore.markProviderAuthSessionConsumed(
    session.authSessionId,
  );
  if (consumed) {
    return { ok: true, session: consumed };
  }

  return {
    ok: false,
    result: failurePage(
      410,
      'Provider login failed',
      'Provider auth session has expired.',
    ),
  };
}

async function exchangeAndPersistProviderCredential(args: {
  code: string;
  codeVerifier: string;
  authSessionId: string;
  providerId: ProviderAuthCredentialProviderId;
  bootstrapStore: ProviderAuthBootstrapStore;
  runtimeStore: ProviderAuthRuntimeStore;
  exchangeCode: ProviderAuthExchangeFn;
}): Promise<ProviderAuthCallbackResult> {
  const {
    code,
    codeVerifier,
    authSessionId,
    providerId,
    bootstrapStore,
    runtimeStore,
    exchangeCode,
  } = args;
  try {
    const tokenResponse = await exchangeCode(code, codeVerifier, {
      providerId,
    });
    const credentialResult =
      buildProviderCredentialFromTokenResponse(tokenResponse);
    if (!credentialResult.ok) {
      bootstrapStore.markProviderAuthSessionFailure(
        authSessionId,
        credentialResult.code,
        credentialResult.message,
      );
      return failurePage(
        errorCodeToStatus(credentialResult.code),
        'Provider login failed',
        credentialResult.message,
      );
    }

    try {
      await runtimeStore.persistProviderCredential(
        credentialResult.credential,
        providerId,
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to write provider credential.';
      bootstrapStore.markProviderAuthSessionFailure(
        authSessionId,
        'provider_auth_write_failed',
        message,
      );
      return failurePage(
        500,
        'Provider login failed',
        'Failed to write provider credential.',
      );
    }

    bootstrapStore.markProviderAuthSessionReady(authSessionId);
    return successPage({
      clearProviderAuthBootstrapState: () =>
        bootstrapStore.clearProviderAuthBootstrapState(),
    });
  } catch (err: unknown) {
    const codeValue = extractProviderAuthErrorCode(err);
    const message =
      err instanceof Error ? err.message : 'Provider login failed.';
    bootstrapStore.markProviderAuthSessionFailure(
      authSessionId,
      codeValue,
      message,
    );
    return failurePage(
      errorCodeToStatus(codeValue),
      'Provider login failed',
      message,
    );
  }
}

function buildProviderCredentialFromTokenResponse(
  tokenResponse: ProviderAuthTokenResponse,
):
  | { ok: true; credential: ProviderCredential }
  | { ok: false; code: ErrorCode; message: string } {
  const accountId = deriveProviderAccountId({
    accessToken: tokenResponse.access_token ?? '',
    ...(tokenResponse.accountId !== undefined
      ? { accountId: tokenResponse.accountId }
      : {}),
    ...(tokenResponse.id_token !== undefined
      ? { idToken: tokenResponse.id_token }
      : {}),
  });

  if (!tokenResponse.access_token || !accountId) {
    return tokenResponse.access_token
      ? {
          ok: false,
          code: 'provider_auth_account_id_missing',
          message:
            'Failed to derive provider accountId from the callback tokens.',
        }
      : {
          ok: false,
          code: 'provider_auth_exchange_failed',
          message: 'Provider callback did not return an access token.',
        };
  }

  return {
    ok: true,
    credential: {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? '',
      accountId,
      expiresAt:
        typeof tokenResponse.expires_in === 'number'
          ? Date.now() + tokenResponse.expires_in * 1000
          : 0,
    },
  };
}
