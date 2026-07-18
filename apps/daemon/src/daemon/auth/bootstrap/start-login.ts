import crypto from 'node:crypto';

import type { ProviderAuthStartResponse } from '../contract.js';

import {
  createPendingProviderAuthTimestamps,
  type PendingProviderAuthSession,
  type ProviderAuthBootstrapStore,
} from './session-store.js';
import {
  getProviderAuthBootstrapProfile,
  PROVIDER_AUTH_ORIGINATOR,
  type ProviderAuthCallbackListenerConfig,
  type ProviderAuthBootstrapProfile,
} from './config.js';
import type { ProviderAuthCredentialProviderId } from '../credentials/store.js';

export const PROVIDER_AUTH_CALLBACK_UNAVAILABLE_MESSAGE =
  'Provider auth callback listener is unavailable.';

export async function startProviderAuthLogin(options: {
  bootstrapStore: ProviderAuthBootstrapStore;
  ensureCallbackServer: (
    callbackListener: ProviderAuthCallbackListenerConfig,
  ) => Promise<void>;
  providerId?: ProviderAuthCredentialProviderId;
}): Promise<ProviderAuthStartResponse> {
  const { bootstrapStore, ensureCallbackServer } = options;
  const profile = await getProviderAuthBootstrapProfile(options.providerId);
  try {
    await ensureCallbackServer(profile.callbackListener);
  } catch (cause: unknown) {
    const error = new Error(PROVIDER_AUTH_CALLBACK_UNAVAILABLE_MESSAGE);
    Object.assign(error, {
      code: 'provider_auth_callback_unavailable' as const,
      cause,
    });
    throw error;
  }

  const existing = bootstrapStore.getPendingProviderAuthSession();
  if (existing?.providerId === profile.providerId) {
    return toStartResponse(existing, profile);
  }

  const state = base64Url(crypto.randomBytes(16));
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const { createdAt, expiresAt } = createPendingProviderAuthTimestamps();
  const session = bootstrapStore.setPendingProviderAuthSession({
    authSessionId: crypto.randomUUID(),
    providerId: profile.providerId,
    state,
    codeVerifier,
    redirectUri: profile.redirectUri,
    createdAt,
    expiresAt,
    status: 'pending',
  });

  return toStartResponse(session, profile);
}

function buildProviderAuthorizeUrl(
  session: Pick<
    PendingProviderAuthSession,
    'providerId' | 'redirectUri' | 'state' | 'codeVerifier'
  >,
  profile: ProviderAuthBootstrapProfile,
): string {
  const codeChallenge = base64Url(
    crypto.createHash('sha256').update(session.codeVerifier).digest(),
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: profile.clientId,
    redirect_uri: session.redirectUri,
    scope: profile.scope,
    state: session.state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  switch (profile.providerId) {
    case 'openai_codex_direct':
      params.set('id_token_add_organizations', 'true');
      params.set('codex_cli_simplified_flow', 'true');
      params.set('originator', PROVIDER_AUTH_ORIGINATOR);
      break;
    case 'grok_oauth':
      params.set('nonce', base64Url(crypto.randomBytes(16)));
      break;
  }

  const url = new URL(profile.authorizeUrl);
  url.search = params.toString();

  return url.toString();
}

function toStartResponse(
  session: PendingProviderAuthSession,
  profile: ProviderAuthBootstrapProfile,
): ProviderAuthStartResponse {
  return {
    authSessionId: session.authSessionId,
    authorizeUrl: buildProviderAuthorizeUrl(session, profile),
    expiresAt: session.expiresAt,
    providerId: profile.providerId,
  };
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
