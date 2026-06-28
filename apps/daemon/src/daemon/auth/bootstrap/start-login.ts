import crypto from 'node:crypto';

import type { ProviderAuthStartResponse } from '../contract.js';

import {
  createPendingProviderAuthTimestamps,
  type PendingProviderAuthSession,
  type ProviderAuthBootstrapStore,
} from './session-store.js';
import {
  PROVIDER_AUTH_AUTHORIZE_URL,
  getRequiredProviderAuthClientId,
  PROVIDER_AUTH_ORIGINATOR,
  PROVIDER_AUTH_REDIRECT_URI,
  PROVIDER_AUTH_SCOPE,
} from './config.js';

export const PROVIDER_AUTH_CALLBACK_UNAVAILABLE_MESSAGE =
  'Provider auth callback listener is unavailable.';

export async function startProviderAuthLogin(options: {
  bootstrapStore: ProviderAuthBootstrapStore;
  ensureCallbackServer: () => Promise<void>;
}): Promise<ProviderAuthStartResponse> {
  const { bootstrapStore, ensureCallbackServer } = options;
  const clientId = await getRequiredProviderAuthClientId();
  try {
    await ensureCallbackServer();
  } catch (cause: unknown) {
    const error = new Error(PROVIDER_AUTH_CALLBACK_UNAVAILABLE_MESSAGE);
    Object.assign(error, {
      code: 'provider_auth_callback_unavailable' as const,
      cause,
    });
    throw error;
  }

  const existing = bootstrapStore.getPendingProviderAuthSession();
  if (existing) {
    return toStartResponse(existing, clientId);
  }

  const state = base64Url(crypto.randomBytes(16));
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const { createdAt, expiresAt } = createPendingProviderAuthTimestamps();
  const session = bootstrapStore.setPendingProviderAuthSession({
    authSessionId: crypto.randomUUID(),
    state,
    codeVerifier,
    redirectUri: PROVIDER_AUTH_REDIRECT_URI,
    createdAt,
    expiresAt,
    status: 'pending',
  });

  return toStartResponse(session, clientId);
}

function buildProviderAuthorizeUrl(
  session: Pick<
    PendingProviderAuthSession,
    'redirectUri' | 'state' | 'codeVerifier'
  >,
  clientId: string,
): string {
  const codeChallenge = base64Url(
    crypto.createHash('sha256').update(session.codeVerifier).digest(),
  );

  const url = new URL(PROVIDER_AUTH_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: session.redirectUri,
    scope: PROVIDER_AUTH_SCOPE,
    state: session.state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: PROVIDER_AUTH_ORIGINATOR,
  }).toString();

  return url.toString();
}

function toStartResponse(
  session: PendingProviderAuthSession,
  clientId: string,
): ProviderAuthStartResponse {
  return {
    authSessionId: session.authSessionId,
    authorizeUrl: buildProviderAuthorizeUrl(session, clientId),
    expiresAt: session.expiresAt,
  };
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
