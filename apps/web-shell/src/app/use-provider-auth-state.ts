import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';

import {
  getProviderAuthStatus,
  logoutProviderAuth,
  startProviderAuth,
} from '../lib/api/provider-auth.js';
import { ApiFetchError } from '../lib/api/client.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { reportVisibleAppError } from './error-reporting.js';

const logger = createLogger('provider-auth');
const PROVIDER_AUTH_OPENAI_HOST = 'auth.openai.com';
const PROVIDER_AUTH_OPENAI_PATH = '/oauth/authorize';
const PROVIDER_AUTH_ALREADY_CONNECTED_NOTICE =
  'Provider account is already connected.';
const PROVIDER_AUTH_POPUP_PREPARING_HTML =
  '<!doctype html><title>Geulbat Provider Login</title><p style="font-family: sans-serif; padding: 24px;">Preparing provider login...</p>';
const PROVIDER_AUTH_TOAST_MS = 3000;
export const PROVIDER_AUTH_READY_POLL_MS = 5000;
const PROVIDER_AUTH_OBSERVE_BEFORE_EXPIRY_MS = 90_000;

interface ReportProviderAuthErrorArgs {
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}

export function useProviderAuthState() {
  const [providerAuthStatus, setProviderAuthStatus] =
    useState<ProviderAuthStatusResponse | null>(null);
  const [providerAuthBusy, setProviderAuthBusy] = useState(false);
  const [providerAuthError, setProviderAuthError] = useState<string | null>(
    null,
  );
  const [providerAuthNotice, setProviderAuthNotice] = useState<string | null>(
    null,
  );
  const previousStatusRef = useRef<ProviderAuthStatusResponse | null>(null);

  const showProviderAlreadyConnectedNotice = useCallback(() => {
    setProviderAuthError(null);
    setProviderAuthNotice(PROVIDER_AUTH_ALREADY_CONNECTED_NOTICE);
  }, []);

  const loadProviderStatus = useCallback(async () => {
    try {
      const status = await getProviderAuthStatus();
      setProviderAuthStatus((current) =>
        isSameProviderAuthStatus(current, status) ? current : status,
      );
      setProviderAuthError(null);
    } catch (err: unknown) {
      setProviderAuthError(
        reportProviderAuthError({
          logContext: 'loadProviderStatus failed',
          visiblePrefix: 'Unable to load provider auth status.',
          error: err,
        }),
      );
    }
  }, []);

  useEffect(() => {
    void loadProviderStatus();
  }, [loadProviderStatus]);

  useEffect(() => {
    if (providerAuthStatus?.state !== 'pending') {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProviderStatus();
    }, providerAuthStatus.pollAfterMs ?? 1000);

    return () => window.clearInterval(timer);
  }, [loadProviderStatus, providerAuthStatus]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    if (didProviderCredentialRefresh(previous, providerAuthStatus)) {
      setProviderAuthNotice('Provider auth refreshed.');
    }
    previousStatusRef.current = providerAuthStatus;
  }, [providerAuthStatus]);

  useEffect(() => {
    if (providerAuthBusy) {
      return;
    }
    const delayMs = getProviderStatusObserveDelayMs(providerAuthStatus);
    if (delayMs === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadProviderStatus();
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [loadProviderStatus, providerAuthBusy, providerAuthStatus]);

  useEffect(() => {
    if (!providerAuthNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setProviderAuthNotice(null);
    }, PROVIDER_AUTH_TOAST_MS);

    return () => window.clearTimeout(timer);
  }, [providerAuthNotice]);

  const handleConnectProvider = useCallback(async () => {
    if (providerAuthStatus?.state === 'ready') {
      showProviderAlreadyConnectedNotice();
      return;
    }

    setProviderAuthBusy(true);
    setProviderAuthError(null);
    const popup = openProviderAuthPopup(window);
    try {
      const result = await startProviderAuth();
      const authorizeUrl = assertAllowedProviderAuthorizeUrl(
        result.authorizeUrl,
      );
      navigateProviderAuthPopup(window, popup, authorizeUrl);
      await loadProviderStatus();
    } catch (err: unknown) {
      popup?.close();
      if (isProviderAuthAlreadyConnectedError(err)) {
        showProviderAlreadyConnectedNotice();
        await loadProviderStatus();
        return;
      }
      setProviderAuthError(
        reportProviderAuthError({
          logContext: 'provider auth start failed',
          visiblePrefix: 'Failed to start provider login.',
          error: err,
        }),
      );
      await loadProviderStatus();
    } finally {
      setProviderAuthBusy(false);
    }
  }, [
    loadProviderStatus,
    providerAuthStatus?.state,
    showProviderAlreadyConnectedNotice,
  ]);

  const handleDisconnectProvider = useCallback(async () => {
    setProviderAuthBusy(true);
    setProviderAuthError(null);
    try {
      await logoutProviderAuth();
      await loadProviderStatus();
    } catch (err: unknown) {
      setProviderAuthError(
        reportProviderAuthError({
          logContext: 'provider auth logout failed',
          visiblePrefix: 'Failed to disconnect provider.',
          error: err,
        }),
      );
    } finally {
      setProviderAuthBusy(false);
    }
  }, [loadProviderStatus]);

  return {
    providerAuthStatus,
    providerAuthBusy,
    providerAuthError,
    providerAuthNotice,
    handleConnectProvider,
    handleDisconnectProvider,
  };
}

function isProviderAuthAlreadyConnectedError(error: unknown): boolean {
  if (!(error instanceof ApiFetchError) || error.status !== 409) {
    return false;
  }
  const body = error.bodyJson;
  return (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    body.code === 'provider_auth_already_connected'
  );
}

function reportProviderAuthError({
  logContext,
  visiblePrefix,
  error,
}: ReportProviderAuthErrorArgs): string {
  return reportVisibleAppError({
    logger,
    logContext,
    visiblePrefix,
    error,
  });
}

function openProviderAuthPopup(targetWindow: Window): Window | null {
  const popup = targetWindow.open('', '_blank');
  if (!popup) {
    return null;
  }

  popup.document.write(PROVIDER_AUTH_POPUP_PREPARING_HTML);
  popup.document.close();
  return popup;
}

function navigateProviderAuthPopup(
  targetWindow: Window,
  popup: Window | null,
  authorizeUrl: string,
): void {
  if (popup) {
    popup.location.replace(authorizeUrl);
    return;
  }

  targetWindow.location.assign(authorizeUrl);
}

export function isAllowedProviderAuthorizeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      return false;
    }

    if (
      url.protocol === 'https:' &&
      url.hostname === PROVIDER_AUTH_OPENAI_HOST &&
      url.pathname === PROVIDER_AUTH_OPENAI_PATH
    ) {
      return true;
    }

    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      isLoopbackHost(url.hostname)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function assertAllowedProviderAuthorizeUrl(rawUrl: string): string {
  if (!isAllowedProviderAuthorizeUrl(rawUrl)) {
    throw new Error('provider auth start returned disallowed authorizeUrl');
  }
  return rawUrl;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function didProviderCredentialRefresh(
  previous: ProviderAuthStatusResponse | null,
  next: ProviderAuthStatusResponse | null,
): boolean {
  return (
    previous?.state === 'ready' &&
    next?.state === 'ready' &&
    typeof previous.expiresAt === 'number' &&
    typeof next.expiresAt === 'number' &&
    next.expiresAt > previous.expiresAt
  );
}

function isSameProviderAuthStatus(
  current: ProviderAuthStatusResponse | null,
  next: ProviderAuthStatusResponse,
): boolean {
  if (!current) {
    return false;
  }

  return (
    current.state === next.state &&
    current.ready === next.ready &&
    current.authSessionId === next.authSessionId &&
    current.expiresAt === next.expiresAt &&
    current.lastErrorCode === next.lastErrorCode &&
    current.lastErrorMessage === next.lastErrorMessage &&
    current.pollAfterMs === next.pollAfterMs
  );
}

export function getProviderStatusObserveDelayMs(
  status: ProviderAuthStatusResponse | null,
  now = Date.now(),
): number | null {
  if (
    status?.state !== 'ready' ||
    !status.ready ||
    typeof status.expiresAt !== 'number'
  ) {
    return null;
  }

  const observeAt = status.expiresAt - PROVIDER_AUTH_OBSERVE_BEFORE_EXPIRY_MS;
  if (observeAt <= now) {
    return PROVIDER_AUTH_READY_POLL_MS;
  }

  return observeAt - now;
}
