/**
 * daemon/auth/refresh — OAuth token refresh for provider credentials.
 *
 * Exchanges saved provider refresh tokens for fresh access tokens without
 * logging credential material. Provider-specific endpoint/client selection
 * comes from the provider-auth bootstrap profile owner.
 */

import {
  DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
  type ProviderAuthCredentialProviderId,
  type ProviderCredential,
} from './store.js';
import { isRecord } from '../../runtime-json.js';
import {
  GROK_OAUTH_TOKEN_URL,
  getProviderAuthBootstrapProfile,
} from '../bootstrap/config.js';
import { INVALID_PROVIDER_CREDENTIAL_MESSAGE } from '../shared.js';

export const GROK_OAUTH_TOKEN_ENDPOINT = GROK_OAUTH_TOKEN_URL;

interface GrokOAuthRefreshTokenRequestInput {
  tokenEndpoint?: string;
  clientId: string;
  refreshToken: string;
}

interface GrokOAuthRefreshTokenRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Headers;
    body: URLSearchParams;
  };
}

interface OAuthRefreshTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

type GrokOAuthRefreshTokenResponse = OAuthRefreshTokenResponse;

type RefreshOptions = {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type ProviderAuthInvalidError = Error & {
  code: 'provider_auth_invalid';
  status?: number;
};

interface ProviderAuthRefreshProfileDefinition {
  invalidCredentialMessage: string;
  failureMessagePrefix: string;
  invalidJsonMessage?: string;
  invalidBodyMessage: string;
  missingAccessTokenMessage: string;
  defaultExpiresInSeconds?: number;
  requireNonEmptyRefreshToken: boolean;
  allowNegativeExpiresIn: boolean;
}

interface ProviderAuthRefreshProfile extends ProviderAuthRefreshProfileDefinition {
  tokenUrl: string;
  clientId: string;
}

const PROVIDER_AUTH_REFRESH_PROFILES = {
  [DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID]: {
    invalidCredentialMessage: INVALID_PROVIDER_CREDENTIAL_MESSAGE,
    failureMessagePrefix: 'Provider token refresh failed',
    invalidBodyMessage:
      'Provider token refresh returned an invalid response body',
    missingAccessTokenMessage:
      'Provider token refresh response missing access_token',
    defaultExpiresInSeconds: 3600,
    requireNonEmptyRefreshToken: false,
    allowNegativeExpiresIn: true,
  },
  grok_oauth: {
    invalidCredentialMessage:
      'Grok OAuth refresh token is invalid. Re-authenticate with Grok.',
    failureMessagePrefix: 'Grok OAuth token refresh failed',
    invalidJsonMessage: 'Grok OAuth token refresh returned invalid JSON',
    invalidBodyMessage:
      'Grok OAuth token refresh returned an invalid response body',
    missingAccessTokenMessage:
      'Grok OAuth token refresh response missing access_token',
    requireNonEmptyRefreshToken: true,
    allowNegativeExpiresIn: false,
  },
} as const satisfies Record<
  ProviderAuthCredentialProviderId,
  ProviderAuthRefreshProfileDefinition
>;

/** Exchange the current refresh token for a fresh access token. */
export async function refreshProviderToken(
  current: ProviderCredential,
  options?: RefreshOptions,
): Promise<ProviderCredential> {
  return refreshProviderCredential(
    DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
    current,
    options,
  );
}

export async function refreshProviderCredential(
  providerId: ProviderAuthCredentialProviderId,
  current: ProviderCredential,
  options?: RefreshOptions,
): Promise<ProviderCredential> {
  const profile = await getProviderAuthRefreshProfile(providerId);
  return refreshProviderCredentialWithProfile(profile, current, options);
}

export function buildGrokOAuthRefreshTokenRequest(
  input: GrokOAuthRefreshTokenRequestInput,
): GrokOAuthRefreshTokenRequest {
  return buildOAuthRefreshTokenRequest({
    tokenEndpoint: input.tokenEndpoint ?? GROK_OAUTH_TOKEN_ENDPOINT,
    clientId: input.clientId,
    refreshToken: input.refreshToken,
    errorPrefix: 'Grok OAuth',
  });
}

export async function refreshGrokOAuthProviderCredential(
  current: ProviderCredential,
  options?: RefreshOptions,
): Promise<ProviderCredential> {
  return refreshProviderCredential('grok_oauth', current, options);
}

export function parseGrokOAuthRefreshTokenResponse(
  value: unknown,
): GrokOAuthRefreshTokenResponse {
  return parseOAuthRefreshTokenResponse(value, {
    invalidBodyMessage:
      PROVIDER_AUTH_REFRESH_PROFILES.grok_oauth.invalidBodyMessage,
    allowNegativeExpiresIn:
      PROVIDER_AUTH_REFRESH_PROFILES.grok_oauth.allowNegativeExpiresIn,
  });
}

async function getProviderAuthRefreshProfile(
  providerId: ProviderAuthCredentialProviderId,
): Promise<ProviderAuthRefreshProfile> {
  const bootstrapProfile = await getProviderAuthBootstrapProfile(providerId);
  return {
    ...PROVIDER_AUTH_REFRESH_PROFILES[providerId],
    tokenUrl: bootstrapProfile.tokenUrl,
    clientId: bootstrapProfile.clientId,
  };
}

async function refreshProviderCredentialWithProfile(
  profile: ProviderAuthRefreshProfile,
  current: ProviderCredential,
  options?: RefreshOptions,
): Promise<ProviderCredential> {
  if (!current.refreshToken) {
    throw new Error(
      'No refresh token available. Re-authenticate with the provider.',
    );
  }

  const request = buildOAuthRefreshTokenRequest({
    tokenEndpoint: profile.tokenUrl,
    clientId: profile.clientId,
    refreshToken: current.refreshToken,
    errorPrefix: 'provider OAuth',
  });
  const response = await (options?.fetchImpl ?? fetch)(
    request.url,
    request.init,
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw createInvalidCredentialError(
        profile.invalidCredentialMessage,
        response.status,
      );
    }

    const text = await readResponseText(response);
    throw new Error(
      `${profile.failureMessagePrefix} (${response.status}): ${text}`,
    );
  }

  const data = parseOAuthRefreshTokenResponse(
    await readJsonResponse(response, profile),
    profile,
  );
  const accessToken = requireResponseAccessToken(
    data.accessToken,
    profile.missingAccessTokenMessage,
  );
  const refreshToken =
    data.refreshToken !== undefined
      ? normalizeResponseRefreshToken(data.refreshToken, profile)
      : current.refreshToken;
  const nowMs = options?.nowMs ?? Date.now;
  const expiresAt =
    data.expiresIn !== undefined
      ? nowMs() + data.expiresIn * 1000
      : profile.defaultExpiresInSeconds !== undefined
        ? nowMs() + profile.defaultExpiresInSeconds * 1000
        : 0;

  return {
    accessToken,
    refreshToken,
    accountId: current.accountId,
    expiresAt,
  };
}

function buildOAuthRefreshTokenRequest(input: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  errorPrefix: string;
}): GrokOAuthRefreshTokenRequest {
  const tokenEndpoint = requireNonEmpty(
    input.tokenEndpoint,
    'tokenEndpoint',
    input.errorPrefix,
  );
  const clientId = requireNonEmpty(
    input.clientId,
    'clientId',
    input.errorPrefix,
  );
  const refreshToken = requireNonEmpty(
    input.refreshToken,
    'refreshToken',
    input.errorPrefix,
  );

  const headers = new Headers();
  headers.set('content-type', 'application/x-www-form-urlencoded');

  return {
    url: tokenEndpoint,
    init: {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    },
  };
}

function parseOAuthRefreshTokenResponse(
  value: unknown,
  options: {
    invalidBodyMessage: string;
    allowNegativeExpiresIn: boolean;
  },
): OAuthRefreshTokenResponse {
  if (!isRecord(value)) {
    throw new Error(options.invalidBodyMessage);
  }

  const accessToken = readOptionalString(
    value,
    'access_token',
    options.invalidBodyMessage,
  );
  const refreshToken = readOptionalString(
    value,
    'refresh_token',
    options.invalidBodyMessage,
  );
  const expiresIn = readOptionalExpiresIn(value, options);

  return {
    ...(accessToken !== undefined ? { accessToken } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
  };
}

async function readJsonResponse(
  response: Response,
  profile: ProviderAuthRefreshProfile,
): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch (error: unknown) {
    if (profile.invalidJsonMessage === undefined) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${profile.invalidJsonMessage}: ${detail}`);
  }
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  invalidBodyMessage: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(invalidBodyMessage);
  }
  return value;
}

function readOptionalExpiresIn(
  record: Record<string, unknown>,
  options: {
    invalidBodyMessage: string;
    allowNegativeExpiresIn: boolean;
  },
): number | undefined {
  const value = record.expires_in;
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (!options.allowNegativeExpiresIn && value < 0)
  ) {
    throw new Error(options.invalidBodyMessage);
  }
  return value;
}

function requireNonEmpty(
  value: string,
  label: string,
  errorPrefix: string,
): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${errorPrefix} ${label} is required`);
  }
  return trimmed;
}

function requireResponseAccessToken(
  value: string | undefined,
  missingMessage: string,
): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(missingMessage);
  }
  return value.trim();
}

function normalizeResponseRefreshToken(
  value: string,
  profile: ProviderAuthRefreshProfile,
): string {
  if (!profile.requireNonEmptyRefreshToken) {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(
      'Grok OAuth token refresh response has empty refresh_token',
    );
  }
  return trimmed;
}

function createInvalidCredentialError(
  message: string,
  status: number,
): ProviderAuthInvalidError {
  return Object.assign(new Error(message), {
    code: 'provider_auth_invalid' as const,
    status,
  });
}
