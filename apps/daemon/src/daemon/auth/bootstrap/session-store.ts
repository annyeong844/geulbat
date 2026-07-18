import type { ErrorCode, ProviderAuthStatusState } from '../contract.js';
import type { ProviderAuthCredentialProviderId } from '../credentials/store.js';

import { PROVIDER_AUTH_PENDING_TTL_MS } from './config.js';

export interface PendingProviderAuthSession {
  authSessionId: string;
  providerId: ProviderAuthCredentialProviderId;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  status: Extract<
    ProviderAuthStatusState,
    'pending' | 'ready' | 'exchange_failed' | 'expired'
  >;
  lastErrorCode?: ErrorCode;
  lastErrorMessage?: string;
}

export interface ProviderAuthBootstrapStore {
  getProviderAuthSessionSnapshot(): PendingProviderAuthSession | null;
  getPendingProviderAuthSession(): PendingProviderAuthSession | null;
  setPendingProviderAuthSession(
    session: PendingProviderAuthSession,
  ): PendingProviderAuthSession;
  resolvePendingProviderAuthSessionByState(
    state: string,
  ): PendingProviderAuthSession | null;
  getProviderAuthSessionSnapshotByState(
    state: string,
  ): PendingProviderAuthSession | null;
  markProviderAuthSessionConsumed(
    authSessionId: string,
  ): PendingProviderAuthSession | null;
  markProviderAuthSessionReady(
    authSessionId: string,
  ): PendingProviderAuthSession | null;
  markProviderAuthSessionFailure(
    authSessionId: string,
    code: ErrorCode,
    message: string,
  ): PendingProviderAuthSession | null;
  markProviderAuthSessionExpired(
    authSessionId: string,
    message?: string,
  ): PendingProviderAuthSession | null;
  clearProviderAuthBootstrapState(): void;
}

export function createProviderAuthBootstrapStore(): ProviderAuthBootstrapStore {
  let currentSession: PendingProviderAuthSession | null = null;

  function expireCurrentSessionIfNeeded(): void {
    if (!currentSession || currentSession.status !== 'pending') {
      return;
    }
    if (currentSession.expiresAt > Date.now()) {
      return;
    }
    currentSession = {
      ...currentSession,
      status: 'expired',
      codeVerifier: '',
      lastErrorCode: 'provider_auth_session_expired',
      lastErrorMessage: sanitizeProviderAuthMessage(
        'The provider login session has expired.',
      ),
    };
  }

  return {
    getProviderAuthSessionSnapshot() {
      expireCurrentSessionIfNeeded();
      return cloneSession(currentSession);
    },
    getPendingProviderAuthSession() {
      expireCurrentSessionIfNeeded();
      if (!currentSession || currentSession.status !== 'pending') {
        return null;
      }
      return cloneSession(currentSession);
    },
    setPendingProviderAuthSession(session) {
      currentSession = { ...session };
      return cloneSession(currentSession)!;
    },
    resolvePendingProviderAuthSessionByState(state) {
      const session = this.getProviderAuthSessionSnapshotByState(state);
      if (!session || session.status !== 'pending') {
        return null;
      }
      return session;
    },
    getProviderAuthSessionSnapshotByState(state) {
      expireCurrentSessionIfNeeded();
      if (!currentSession) {
        return null;
      }
      if (currentSession.state !== state) {
        return null;
      }
      return cloneSession(currentSession);
    },
    markProviderAuthSessionConsumed(authSessionId) {
      if (!currentSession || currentSession.authSessionId !== authSessionId) {
        return null;
      }
      if (!currentSession.consumedAt) {
        currentSession = {
          ...currentSession,
          consumedAt: Date.now(),
        };
      }
      return cloneSession(currentSession);
    },
    markProviderAuthSessionReady(authSessionId) {
      if (!currentSession || currentSession.authSessionId !== authSessionId) {
        return null;
      }
      const {
        lastErrorCode: _lastErrorCode,
        lastErrorMessage: _lastErrorMessage,
        ...sessionWithoutError
      } = currentSession;
      currentSession = {
        ...sessionWithoutError,
        status: 'ready',
        codeVerifier: '',
      };
      return cloneSession(currentSession);
    },
    markProviderAuthSessionFailure(authSessionId, code, message) {
      if (!currentSession || currentSession.authSessionId !== authSessionId) {
        return null;
      }
      currentSession = {
        ...currentSession,
        status: 'exchange_failed',
        consumedAt: currentSession.consumedAt ?? Date.now(),
        codeVerifier: '',
        lastErrorCode: code,
        lastErrorMessage: sanitizeProviderAuthMessage(message),
      };
      return cloneSession(currentSession);
    },
    markProviderAuthSessionExpired(
      authSessionId,
      message = 'The provider login session has expired.',
    ) {
      if (!currentSession || currentSession.authSessionId !== authSessionId) {
        return null;
      }
      currentSession = {
        ...currentSession,
        status: 'expired',
        codeVerifier: '',
        lastErrorCode: 'provider_auth_session_expired',
        lastErrorMessage: sanitizeProviderAuthMessage(message),
      };
      return cloneSession(currentSession);
    },
    clearProviderAuthBootstrapState() {
      currentSession = null;
    },
  };
}

export function sanitizeProviderAuthMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function cloneSession(
  session: PendingProviderAuthSession | null,
): PendingProviderAuthSession | null {
  return session ? { ...session } : null;
}

export function createPendingProviderAuthTimestamps(now = Date.now()): {
  createdAt: number;
  expiresAt: number;
} {
  return {
    createdAt: now,
    expiresAt: now + PROVIDER_AUTH_PENDING_TTL_MS,
  };
}
