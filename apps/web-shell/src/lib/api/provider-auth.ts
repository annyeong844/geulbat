import {
  isProviderAuthLogoutResponse,
  isProviderAuthStartResponse,
  isProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';
import type {
  ProviderAuthLogoutResponse,
  ProviderAuthProviderId,
  ProviderAuthStartResponse,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';

import { apiFetch } from './client.js';

export function startProviderAuth(
  providerId?: ProviderAuthProviderId,
): Promise<ProviderAuthStartResponse> {
  return apiFetch(
    '/api/provider-auth/start',
    {
      method: 'POST',
      body: JSON.stringify({
        launcher: 'web-shell',
        ...(providerId !== undefined ? { providerId } : {}),
      }),
    },
    isProviderAuthStartResponse,
  );
}

export function getProviderAuthStatus(
  providerId?: ProviderAuthProviderId,
): Promise<ProviderAuthStatusResponse> {
  const query =
    providerId !== undefined
      ? `?providerId=${encodeURIComponent(providerId)}`
      : '';
  return apiFetch(
    `/api/provider-auth/status${query}`,
    undefined,
    isProviderAuthStatusResponse,
  );
}

export function logoutProviderAuth(
  providerId?: ProviderAuthProviderId,
): Promise<ProviderAuthLogoutResponse> {
  return apiFetch(
    '/api/provider-auth/logout',
    {
      method: 'POST',
      body: JSON.stringify({
        ...(providerId !== undefined ? { providerId } : {}),
      }),
    },
    isProviderAuthLogoutResponse,
  );
}
