/**
 * daemon/auth/refresh — OAuth token refresh for the upstream provider
 *
 * Uses the ChatGPT OAuth token endpoint to exchange a refresh token for a new
 * access token.  This is an unsupported adapter zone -- the official
 * recommendation is to let the upstream agent manage auth.  If the endpoint or
 * client_id changes, only this file needs updating.
 */

import { isRecord } from '../../runtime-json.js';
import {
  getRequiredProviderAuthClientId,
  PROVIDER_AUTH_TOKEN_URL,
} from '../bootstrap/config.js';
import { INVALID_PROVIDER_CREDENTIAL_MESSAGE } from '../shared.js';
import type { ProviderCredential } from './store.js';

/** Exchange the current refresh token for a fresh access token. */
export async function refreshProviderToken(
  current: ProviderCredential,
  options?: { fetchImpl?: typeof fetch },
): Promise<ProviderCredential> {
  if (!current.refreshToken) {
    throw new Error(
      'No refresh token available. Re-authenticate with the provider.',
    );
  }
  const clientId = await getRequiredProviderAuthClientId();

  const res = await (options?.fetchImpl ?? fetch)(PROVIDER_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: current.refreshToken,
    }),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(INVALID_PROVIDER_CREDENTIAL_MESSAGE), {
        code: 'provider_auth_invalid',
        status: res.status,
      });
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Provider token refresh failed (${res.status}): ${text}`);
  }

  const data = parseRefreshResponse((await res.json()) as unknown);

  if (!data.access_token) {
    throw new Error('Provider token refresh response missing access_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? current.refreshToken,
    accountId: current.accountId,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

function parseRefreshResponse(value: unknown): {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
} {
  if (!isRecord(value)) {
    throw new Error('Provider token refresh returned an invalid response body');
  }

  const record = value;
  if (
    (record.access_token !== undefined &&
      typeof record.access_token !== 'string') ||
    (record.refresh_token !== undefined &&
      typeof record.refresh_token !== 'string') ||
    (record.expires_in !== undefined &&
      (typeof record.expires_in !== 'number' ||
        !Number.isFinite(record.expires_in)))
  ) {
    throw new Error('Provider token refresh returned an invalid response body');
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
  };
}
