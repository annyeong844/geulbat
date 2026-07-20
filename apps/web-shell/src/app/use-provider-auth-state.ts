import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  DEFAULT_PROVIDER_AUTH_PROVIDER_ID,
  PROVIDER_AUTH_PROVIDER_IDS,
  type ProviderAuthProviderId,
  type ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';

import {
  getProviderAuthStatus,
  logoutProviderAuth,
  startProviderAuth,
} from '../lib/api/provider-auth.js';
import { ApiFetchError } from '../lib/api/client.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { reportVisibleAppError } from './error-reporting.js';

export type ProviderAuthStatusByProvider = Record<
  ProviderAuthProviderId,
  ProviderAuthStatusResponse | null
>;
export type ProviderAuthErrorByProvider = Record<
  ProviderAuthProviderId,
  string | null
>;

const logger = createLogger('provider-auth');
const PROVIDER_AUTH_OPENAI_HOST = 'auth.openai.com';
const PROVIDER_AUTH_OPENAI_PATH = '/oauth/authorize';
const PROVIDER_AUTH_XAI_HOST = 'auth.x.ai';
const PROVIDER_AUTH_XAI_PATH = '/oauth2/authorize';
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

interface UseProviderAuthStatusPollingArgs {
  providerAuthBusyProviderId: ProviderAuthProviderId | null;
  setProviderAuthErrors: Dispatch<SetStateAction<ProviderAuthErrorByProvider>>;
  setProviderAuthNotice: Dispatch<SetStateAction<string | null>>;
}

interface ProviderAuthStatusPolling {
  providerAuthStatuses: ProviderAuthStatusByProvider;
  loadProviderStatus: (providerId?: ProviderAuthProviderId) => Promise<void>;
}

export function useProviderAuthState() {
  const [providerAuthBusyProviderId, setProviderAuthBusyProviderId] =
    useState<ProviderAuthProviderId | null>(null);
  const [providerAuthErrors, setProviderAuthErrors] =
    useState<ProviderAuthErrorByProvider>(() =>
      createProviderRecord<string | null>(null),
    );
  const [providerAuthNotice, setProviderAuthNotice] = useState<string | null>(
    null,
  );
  const { providerAuthStatuses, loadProviderStatus } =
    useProviderAuthStatusPolling({
      providerAuthBusyProviderId,
      setProviderAuthErrors,
      setProviderAuthNotice,
    });

  const showProviderAlreadyConnectedNotice = useCallback(
    (providerId: ProviderAuthProviderId) => {
      setProviderAuthErrors((current) =>
        withProviderValue(current, providerId, null),
      );
      setProviderAuthNotice(PROVIDER_AUTH_ALREADY_CONNECTED_NOTICE);
    },
    [],
  );

  useEffect(() => {
    if (!providerAuthNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setProviderAuthNotice(null);
    }, PROVIDER_AUTH_TOAST_MS);

    return () => window.clearTimeout(timer);
  }, [providerAuthNotice]);

  const handleConnectProvider = useCallback(
    async (
      providerId: ProviderAuthProviderId = DEFAULT_PROVIDER_AUTH_PROVIDER_ID,
    ) => {
      if (providerAuthStatuses[providerId]?.state === 'ready') {
        showProviderAlreadyConnectedNotice(providerId);
        return;
      }

      setProviderAuthBusyProviderId(providerId);
      setProviderAuthErrors((current) =>
        withProviderValue(current, providerId, null),
      );
      const popup = openProviderAuthPopup(window);
      try {
        const result = await startProviderAuth(providerId);
        const authorizeUrl = assertAllowedProviderAuthorizeUrl(
          result.authorizeUrl,
        );
        navigateProviderAuthPopup(window, popup, authorizeUrl);
        await loadProviderStatus(providerId);
      } catch (err: unknown) {
        popup?.close();
        if (isProviderAuthAlreadyConnectedError(err)) {
          showProviderAlreadyConnectedNotice(providerId);
          await loadProviderStatus(providerId);
          return;
        }
        setProviderAuthErrors((current) =>
          withProviderValue(
            current,
            providerId,
            reportProviderAuthError({
              logContext: 'provider auth start failed',
              visiblePrefix: 'Failed to start provider login.',
              error: err,
            }),
          ),
        );
        await loadProviderStatus(providerId);
      } finally {
        setProviderAuthBusyProviderId(null);
      }
    },
    [
      loadProviderStatus,
      providerAuthStatuses,
      showProviderAlreadyConnectedNotice,
    ],
  );

  const handleDisconnectProvider = useCallback(
    async (
      providerId: ProviderAuthProviderId = DEFAULT_PROVIDER_AUTH_PROVIDER_ID,
    ) => {
      setProviderAuthBusyProviderId(providerId);
      setProviderAuthErrors((current) =>
        withProviderValue(current, providerId, null),
      );
      try {
        await logoutProviderAuth(providerId);
        await loadProviderStatus(providerId);
      } catch (err: unknown) {
        setProviderAuthErrors((current) =>
          withProviderValue(
            current,
            providerId,
            reportProviderAuthError({
              logContext: 'provider auth logout failed',
              visiblePrefix: 'Failed to disconnect provider.',
              error: err,
            }),
          ),
        );
      } finally {
        setProviderAuthBusyProviderId(null);
      }
    },
    [loadProviderStatus],
  );

  return {
    providerAuthStatus: providerAuthStatuses[DEFAULT_PROVIDER_AUTH_PROVIDER_ID],
    providerAuthStatuses,
    providerAuthBusy: providerAuthBusyProviderId !== null,
    providerAuthBusyProviderId,
    providerAuthError: providerAuthErrors[DEFAULT_PROVIDER_AUTH_PROVIDER_ID],
    providerAuthErrors,
    providerAuthNotice,
    handleConnectProvider,
    handleDisconnectProvider,
  };
}

function useProviderAuthStatusPolling({
  providerAuthBusyProviderId,
  setProviderAuthErrors,
  setProviderAuthNotice,
}: UseProviderAuthStatusPollingArgs): ProviderAuthStatusPolling {
  const [providerAuthStatuses, setProviderAuthStatuses] =
    useState<ProviderAuthStatusByProvider>(() =>
      createProviderRecord<ProviderAuthStatusResponse | null>(null),
    );
  const previousStatusesRef = useRef<ProviderAuthStatusByProvider>(
    createProviderRecord<ProviderAuthStatusResponse | null>(null),
  );

  const loadProviderStatus = useCallback(
    async (providerId?: ProviderAuthProviderId) => {
      const providerIds =
        providerId === undefined
          ? PROVIDER_AUTH_PROVIDER_IDS
          : ([providerId] as const);
      await Promise.all(
        providerIds.map(async (id) => {
          try {
            const status = await getProviderAuthStatus(id);
            assertValidProviderAuthStatus(status);
            setProviderAuthStatuses((current) =>
              withProviderValue(
                current,
                id,
                isSameProviderAuthStatus(current[id], status)
                  ? current[id]
                  : status,
              ),
            );
            setProviderAuthErrors((current) =>
              withProviderValue(current, id, null),
            );
          } catch (err: unknown) {
            setProviderAuthErrors((current) =>
              withProviderValue(
                current,
                id,
                reportProviderAuthError({
                  logContext: 'loadProviderStatus failed',
                  visiblePrefix: 'Unable to load provider auth status.',
                  error: err,
                }),
              ),
            );
          }
        }),
      );
    },
    [setProviderAuthErrors],
  );

  useEffect(() => {
    void loadProviderStatus();
  }, [loadProviderStatus]);

  useEffect(() => {
    const delayMs = getPendingStatusPollDelayMs(providerAuthStatuses);
    if (delayMs === null) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProviderStatus();
    }, delayMs);

    return () => window.clearInterval(timer);
  }, [loadProviderStatus, providerAuthStatuses]);

  useEffect(() => {
    const previous = previousStatusesRef.current;
    for (const providerId of PROVIDER_AUTH_PROVIDER_IDS) {
      if (
        didProviderCredentialRefresh(
          previous[providerId],
          providerAuthStatuses[providerId],
        )
      ) {
        setProviderAuthNotice(
          `${getProviderLabel(providerId)} auth refreshed.`,
        );
        break;
      }
    }
    previousStatusesRef.current = providerAuthStatuses;
  }, [providerAuthStatuses, setProviderAuthNotice]);

  useEffect(() => {
    if (providerAuthBusyProviderId !== null) {
      return;
    }
    const delayMs = getProviderStatusesObserveDelayMs(providerAuthStatuses);
    if (delayMs === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      void loadProviderStatus();
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [loadProviderStatus, providerAuthBusyProviderId, providerAuthStatuses]);

  return {
    providerAuthStatuses,
    loadProviderStatus,
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
      ((url.hostname === PROVIDER_AUTH_OPENAI_HOST &&
        url.pathname === PROVIDER_AUTH_OPENAI_PATH) ||
        (url.hostname === PROVIDER_AUTH_XAI_HOST &&
          url.pathname === PROVIDER_AUTH_XAI_PATH))
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
  next: ProviderAuthStatusResponse | null,
): boolean {
  if (!current || !next) {
    return current === next;
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

function assertValidProviderAuthStatus(
  status: ProviderAuthStatusResponse,
): void {
  if (
    status.state === 'pending' &&
    (!Number.isInteger(status.pollAfterMs) || status.pollAfterMs <= 0)
  ) {
    throw new Error('provider auth status returned invalid pollAfterMs');
  }
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

function getPendingStatusPollDelayMs(
  statuses: ProviderAuthStatusByProvider,
): number | null {
  const delays = PROVIDER_AUTH_PROVIDER_IDS.flatMap((providerId) => {
    const status = statuses[providerId];
    return status?.state === 'pending' ? [status.pollAfterMs ?? 1000] : [];
  });
  return minNumberOrNull(delays);
}

function getProviderStatusesObserveDelayMs(
  statuses: ProviderAuthStatusByProvider,
): number | null {
  return minNumberOrNull(
    PROVIDER_AUTH_PROVIDER_IDS.flatMap((providerId) => {
      const delayMs = getProviderStatusObserveDelayMs(statuses[providerId]);
      return delayMs === null ? [] : [delayMs];
    }),
  );
}

function minNumberOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.min(...values);
}

function createProviderRecord<T>(value: T): Record<ProviderAuthProviderId, T> {
  return {
    openai_codex_direct: value,
    grok_oauth: value,
  };
}

function withProviderValue<T>(
  record: Record<ProviderAuthProviderId, T>,
  providerId: ProviderAuthProviderId,
  value: T,
): Record<ProviderAuthProviderId, T> {
  if (Object.is(record[providerId], value)) {
    return record;
  }
  return {
    ...record,
    [providerId]: value,
  };
}

function getProviderLabel(providerId: ProviderAuthProviderId): string {
  return providerId === 'grok_oauth' ? 'Grok' : 'Codex';
}
