import type { ProviderCredential } from './credentials/store.js';

export const INVALID_PROVIDER_CREDENTIAL_MESSAGE =
  'Saved provider credential is invalid. Reconnect the provider.';
export const EXPIRED_PROVIDER_CREDENTIAL_MESSAGE =
  'Saved provider credential has expired. Reconnect the provider.';

export interface ProviderAuthStatus {
  ready: boolean;
  source: 'file' | 'missing';
  expiresAt?: number;
  expiresInMs?: number;
  refreshRecommended?: boolean;
  refreshInFlight: boolean;
}

export function isProviderCredentialUsable(
  credential: ProviderCredential | null,
): credential is ProviderCredential {
  if (!credential?.accessToken || !credential.accountId) {
    return false;
  }

  if (credential.expiresAt === 0) {
    return true;
  }

  if (credential.expiresAt > Date.now()) {
    return true;
  }

  return Boolean(credential.refreshToken);
}

export function requiresProviderReconnect(
  error: {
    code?: string;
  } | null,
): boolean {
  return error?.code === 'provider_auth_invalid';
}
