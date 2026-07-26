import type { ErrorCode } from '../contract.js';
import type { ProviderAuthCredentialProviderId } from '../credentials/store.js';

import { PROVIDER_AUTH_PENDING_TTL_MS } from './config.js';

interface ProviderAuthSessionFields {
  authSessionId: string;
  providerId: ProviderAuthCredentialProviderId;
  state: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

type ProviderAuthPendingSession = ProviderAuthSessionFields & {
  status: 'pending';
  codeVerifier: string;
  consumedAt?: never;
  lastErrorCode?: never;
  lastErrorMessage?: never;
};

type ProviderAuthConsumedSession = ProviderAuthSessionFields & {
  status: 'pending';
  codeVerifier: string;
  consumedAt: number;
  lastErrorCode?: never;
  lastErrorMessage?: never;
};

type ProviderAuthReadySession = ProviderAuthSessionFields & {
  status: 'ready';
  codeVerifier: '';
  consumedAt: number;
  lastErrorCode?: never;
  lastErrorMessage?: never;
};

type ProviderAuthFailedSession = ProviderAuthSessionFields & {
  status: 'exchange_failed';
  codeVerifier: '';
  consumedAt: number;
  lastErrorCode: ErrorCode;
  lastErrorMessage: string;
};

type ProviderAuthExpiredSession = ProviderAuthSessionFields & {
  status: 'expired';
  codeVerifier: '';
  consumedAt?: number;
  lastErrorCode: ErrorCode;
  lastErrorMessage: string;
};

export type PendingProviderAuthSession =
  | ProviderAuthPendingSession
  | ProviderAuthConsumedSession
  | ProviderAuthReadySession
  | ProviderAuthFailedSession
  | ProviderAuthExpiredSession;

export interface ProviderAuthBootstrapStore {
  getProviderAuthSessionSnapshot(): PendingProviderAuthSession | null;
  getPendingProviderAuthSession(): ProviderAuthPendingSession | null;
  setPendingProviderAuthSession(
    session: ProviderAuthPendingSession,
  ): ProviderAuthPendingSession;
  resolvePendingProviderAuthSessionByState(
    state: string,
  ): ProviderAuthPendingSession | null;
  getProviderAuthSessionSnapshotByState(
    state: string,
  ): PendingProviderAuthSession | null;
  markProviderAuthSessionConsumed(
    authSessionId: string,
  ): ProviderAuthConsumedSession | null;
  markProviderAuthSessionReady(
    authSessionId: string,
  ): ProviderAuthReadySession | null;
  markProviderAuthSessionFailure(
    authSessionId: string,
    code: ErrorCode,
    message: string,
  ): ProviderAuthFailedSession | null;
  markProviderAuthSessionExpired(
    authSessionId: string,
    message?: string,
  ): ProviderAuthExpiredSession | null;
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
    const expiredSession: ProviderAuthExpiredSession = {
      ...currentSession,
      status: 'expired',
      codeVerifier: '',
      lastErrorCode: 'provider_auth_session_expired',
      lastErrorMessage: sanitizeProviderAuthMessage(
        'The provider login session has expired.',
      ),
    };
    currentSession = expiredSession;
  }

  return {
    getProviderAuthSessionSnapshot() {
      expireCurrentSessionIfNeeded();
      return currentSession === null ? null : cloneSession(currentSession);
    },
    getPendingProviderAuthSession() {
      expireCurrentSessionIfNeeded();
      if (
        !currentSession ||
        currentSession.status !== 'pending' ||
        currentSession.consumedAt !== undefined
      ) {
        return null;
      }
      return cloneSession(currentSession);
    },
    setPendingProviderAuthSession(session) {
      currentSession = cloneSession(session);
      return cloneSession(session);
    },
    resolvePendingProviderAuthSessionByState(state) {
      const session = this.getProviderAuthSessionSnapshotByState(state);
      if (
        !session ||
        session.status !== 'pending' ||
        session.consumedAt !== undefined
      ) {
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
      if (
        !currentSession ||
        currentSession.authSessionId !== authSessionId ||
        currentSession.status !== 'pending' ||
        currentSession.consumedAt !== undefined
      ) {
        return null;
      }
      const consumedSession: ProviderAuthConsumedSession = {
        ...currentSession,
        consumedAt: Date.now(),
      };
      currentSession = consumedSession;
      return cloneSession(consumedSession);
    },
    markProviderAuthSessionReady(authSessionId) {
      if (
        !currentSession ||
        currentSession.authSessionId !== authSessionId ||
        currentSession.consumedAt === undefined
      ) {
        return null;
      }
      const consumedAt = currentSession.consumedAt;
      const {
        lastErrorCode: _lastErrorCode,
        lastErrorMessage: _lastErrorMessage,
        ...sessionWithoutError
      } = currentSession;
      const readySession: ProviderAuthReadySession = {
        ...sessionWithoutError,
        status: 'ready',
        codeVerifier: '',
        consumedAt,
      };
      currentSession = readySession;
      return cloneSession(readySession);
    },
    markProviderAuthSessionFailure(authSessionId, code, message) {
      if (!currentSession || currentSession.authSessionId !== authSessionId) {
        return null;
      }
      const failedSession: ProviderAuthFailedSession = {
        ...currentSession,
        status: 'exchange_failed',
        consumedAt: currentSession.consumedAt ?? Date.now(),
        codeVerifier: '',
        lastErrorCode: code,
        lastErrorMessage: sanitizeProviderAuthMessage(message),
      };
      currentSession = failedSession;
      return cloneSession(failedSession);
    },
    markProviderAuthSessionExpired(
      authSessionId,
      message = 'The provider login session has expired.',
    ) {
      if (!currentSession || currentSession.authSessionId !== authSessionId) {
        return null;
      }
      const expiredSession: ProviderAuthExpiredSession = {
        ...currentSession,
        status: 'expired',
        codeVerifier: '',
        lastErrorCode: 'provider_auth_session_expired',
        lastErrorMessage: sanitizeProviderAuthMessage(message),
      };
      currentSession = expiredSession;
      return cloneSession(expiredSession);
    },
    clearProviderAuthBootstrapState() {
      currentSession = null;
    },
  };
}

export function sanitizeProviderAuthMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function cloneSession<Session extends PendingProviderAuthSession>(
  session: Session,
): Session {
  return { ...session };
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
