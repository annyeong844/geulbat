import crypto from 'node:crypto';

import { isRecord } from '../../runtime-json.js';
import type { ErrorCode } from '../contract.js';

import {
  PROVIDER_AUTH_EXCHANGE_TIMEOUT_MS,
  getProviderAuthBootstrapProfile,
} from './config.js';
import type { ProviderAuthCredentialProviderId } from '../credentials/store.js';

interface TokenExchangeResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  accountId?: string;
}

class ProviderAuthExchangeError extends Error {
  readonly providerAuthCode: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProviderAuthExchangeError';
    this.providerAuthCode = code;
  }
}

export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  options?: {
    fetchImpl?: typeof fetch;
    providerId?: ProviderAuthCredentialProviderId;
    timeoutMs?: number;
  },
): Promise<TokenExchangeResponse> {
  const profile = await getProviderAuthBootstrapProfile(options?.providerId);
  let attempt = 0;

  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? PROVIDER_AUTH_EXCHANGE_TIMEOUT_MS,
    );
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: profile.clientId,
      code,
      redirect_uri: profile.redirectUri,
      code_verifier: codeVerifier,
    });

    if (profile.includePkceChallengeInTokenExchange) {
      body.set('code_challenge', createPkceCodeChallenge(codeVerifier));
      body.set('code_challenge_method', 'S256');
    }

    try {
      const res = await (options?.fetchImpl ?? fetch)(profile.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        ...(profile.tokenExchangeRedirectMode !== undefined
          ? { redirect: profile.tokenExchangeRedirectMode }
          : {}),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const message = await res.text().catch(() => '');
        throw withProviderAuthCode(
          'provider_auth_exchange_failed',
          `Provider token exchange failed (${res.status}): ${message}`,
        );
      }

      return parseTokenExchangeResponse((await res.json()) as unknown);
    } catch (err: unknown) {
      clearTimeout(timeout);

      if (controller.signal.aborted) {
        throw withProviderAuthCode(
          'provider_auth_exchange_timeout',
          'Provider token exchange timed out.',
        );
      }

      if (attempt < 2 && isTransportFailure(err)) {
        continue;
      }

      if (err instanceof ProviderAuthExchangeError) {
        throw err;
      }

      throw withProviderAuthCode(
        'provider_auth_exchange_failed',
        err instanceof Error ? err.message : 'Provider token exchange failed.',
      );
    }
  }
}

function parseTokenExchangeResponse(value: unknown): TokenExchangeResponse {
  if (!isRecord(value)) {
    throw withProviderAuthCode(
      'provider_auth_exchange_failed',
      'Provider token exchange returned an invalid response body.',
    );
  }

  const record = value;
  if (
    (record.access_token !== undefined &&
      typeof record.access_token !== 'string') ||
    (record.refresh_token !== undefined &&
      typeof record.refresh_token !== 'string') ||
    (record.id_token !== undefined && typeof record.id_token !== 'string') ||
    (record.accountId !== undefined && typeof record.accountId !== 'string') ||
    (record.expires_in !== undefined &&
      (typeof record.expires_in !== 'number' ||
        !Number.isFinite(record.expires_in)))
  ) {
    throw withProviderAuthCode(
      'provider_auth_exchange_failed',
      'Provider token exchange returned an invalid response body.',
    );
  }

  return {
    ...(record.access_token !== undefined
      ? { access_token: record.access_token }
      : {}),
    ...(record.refresh_token !== undefined
      ? { refresh_token: record.refresh_token }
      : {}),
    ...(record.expires_in !== undefined
      ? { expires_in: record.expires_in }
      : {}),
    ...(record.id_token !== undefined ? { id_token: record.id_token } : {}),
    ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
  };
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

export function extractProviderAuthErrorCode(err: unknown): ErrorCode {
  if (err instanceof ProviderAuthExchangeError) {
    return err.providerAuthCode;
  }
  return 'provider_auth_exchange_failed';
}

function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const cause = err.cause;
  const code = isRecord(cause) ? cause.code : undefined;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    err.name === 'TypeError'
  );
}

function withProviderAuthCode(
  code: ErrorCode,
  message: string,
): ProviderAuthExchangeError {
  return new ProviderAuthExchangeError(code, message);
}
