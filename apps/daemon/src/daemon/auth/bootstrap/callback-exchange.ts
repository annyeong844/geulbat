import { isRecord } from '@geulbat/protocol/runtime-utils';
import type { ErrorCode } from '@geulbat/protocol/errors';

import {
  PROVIDER_AUTH_EXCHANGE_TIMEOUT_MS,
  getRequiredProviderAuthClientId,
  PROVIDER_AUTH_REDIRECT_URI,
  PROVIDER_AUTH_TOKEN_URL,
} from './config.js';

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
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<TokenExchangeResponse> {
  const clientId = await getRequiredProviderAuthClientId();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? PROVIDER_AUTH_EXCHANGE_TIMEOUT_MS,
    );

    try {
      const res = await (options?.fetchImpl ?? fetch)(PROVIDER_AUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: PROVIDER_AUTH_REDIRECT_URI,
          code_verifier: codeVerifier,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const message = await res.text().catch(() => '');
        throw withProviderAuthCode(
          'provider_auth_exchange_failed',
          `Provider token exchange failed (${res.status}): ${message.slice(0, 240)}`,
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
  const cause = err as Error & { cause?: { code?: string } };
  const code = cause.cause?.code;
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
