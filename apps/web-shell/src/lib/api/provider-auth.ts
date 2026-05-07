import {
  isProviderAuthLogoutResponse,
  isProviderAuthStartResponse,
  isProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';
import type {
  ProviderAuthLogoutResponse,
  ProviderAuthStartResponse,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';

import { apiFetch } from './client.js';

export function startProviderAuth(): Promise<ProviderAuthStartResponse> {
  return apiFetch(
    '/api/provider-auth/start',
    {
      method: 'POST',
      body: JSON.stringify({
        launcher: 'web-shell',
      }),
    },
    isProviderAuthStartResponse,
  );
}

export function getProviderAuthStatus(): Promise<ProviderAuthStatusResponse> {
  return apiFetch(
    '/api/provider-auth/status',
    undefined,
    isProviderAuthStatusResponse,
  );
}

export function logoutProviderAuth(): Promise<ProviderAuthLogoutResponse> {
  return apiFetch(
    '/api/provider-auth/logout',
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
    isProviderAuthLogoutResponse,
  );
}
