import type { GenericApiError } from '../error-codes.js';
import {
  resolveProviderAuthCredentialProviderId,
  writeProviderAuthFile,
  type ProviderAuthCredentialProviderId,
  type ProviderCredential,
} from './credentials/store.js';

type ProviderAuthLoadError = GenericApiError;

export interface ProviderAuthRuntimeStore {
  hasHydratedProviderAuth(
    providerId?: ProviderAuthCredentialProviderId,
  ): boolean;
  setHydratedProviderAuth(
    hydrated: boolean,
    providerId?: ProviderAuthCredentialProviderId,
  ): void;
  getCachedProviderCredential(
    providerId?: ProviderAuthCredentialProviderId,
  ): ProviderCredential | null;
  setCachedProviderCredential(
    credential: ProviderCredential | null,
    providerId?: ProviderAuthCredentialProviderId,
  ): void;
  getCachedProviderAuthLoadError(
    providerId?: ProviderAuthCredentialProviderId,
  ): ProviderAuthLoadError | null;
  setCachedProviderAuthLoadError(
    error: ProviderAuthLoadError | null,
    providerId?: ProviderAuthCredentialProviderId,
  ): void;
  getCachedProviderAuthRefreshError(
    providerId?: ProviderAuthCredentialProviderId,
  ): ProviderAuthLoadError | null;
  setCachedProviderAuthRefreshError(
    error: ProviderAuthLoadError | null,
    providerId?: ProviderAuthCredentialProviderId,
  ): void;
  getProviderAuthRefreshPromise(
    providerId?: ProviderAuthCredentialProviderId,
  ): Promise<void> | null;
  setProviderAuthRefreshPromise(
    promise: Promise<void> | null,
    providerId?: ProviderAuthCredentialProviderId,
  ): void;
  persistProviderCredential(
    credential: ProviderCredential,
    providerId?: ProviderAuthCredentialProviderId,
  ): Promise<void>;
  clearProviderAuthRuntimeState(
    providerId?: ProviderAuthCredentialProviderId,
  ): void;
}

interface ProviderAuthRuntimeProviderState {
  cachedCredential: ProviderCredential | null;
  refreshPromise: Promise<void> | null;
  cachedLoadError: ProviderAuthLoadError | null;
  cachedRefreshError: ProviderAuthLoadError | null;
  hydratedProviderAuth: boolean;
}

function cloneProviderCredential(
  credential: ProviderCredential,
): ProviderCredential {
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    accountId: credential.accountId,
    expiresAt: credential.expiresAt,
  };
}

function cloneProviderAuthLoadError(
  error: ProviderAuthLoadError,
): ProviderAuthLoadError {
  return { ...error };
}

export function createProviderAuthRuntimeStore(): ProviderAuthRuntimeStore {
  const providerStates = new Map<
    ProviderAuthCredentialProviderId,
    ProviderAuthRuntimeProviderState
  >();

  return {
    hasHydratedProviderAuth(providerId) {
      return getProviderAuthRuntimeState(providerStates, providerId)
        .hydratedProviderAuth;
    },
    setHydratedProviderAuth(hydrated, providerId) {
      getProviderAuthRuntimeState(
        providerStates,
        providerId,
      ).hydratedProviderAuth = hydrated;
    },
    getCachedProviderCredential(providerId) {
      const { cachedCredential } = getProviderAuthRuntimeState(
        providerStates,
        providerId,
      );
      return cachedCredential
        ? cloneProviderCredential(cachedCredential)
        : null;
    },
    setCachedProviderCredential(credential, providerId) {
      getProviderAuthRuntimeState(providerStates, providerId).cachedCredential =
        credential ? cloneProviderCredential(credential) : null;
    },
    getCachedProviderAuthLoadError(providerId) {
      const { cachedLoadError } = getProviderAuthRuntimeState(
        providerStates,
        providerId,
      );
      return cachedLoadError
        ? cloneProviderAuthLoadError(cachedLoadError)
        : null;
    },
    setCachedProviderAuthLoadError(error, providerId) {
      getProviderAuthRuntimeState(providerStates, providerId).cachedLoadError =
        error ? cloneProviderAuthLoadError(error) : null;
    },
    getCachedProviderAuthRefreshError(providerId) {
      const { cachedRefreshError } = getProviderAuthRuntimeState(
        providerStates,
        providerId,
      );
      return cachedRefreshError
        ? cloneProviderAuthLoadError(cachedRefreshError)
        : null;
    },
    setCachedProviderAuthRefreshError(error, providerId) {
      getProviderAuthRuntimeState(
        providerStates,
        providerId,
      ).cachedRefreshError = error ? cloneProviderAuthLoadError(error) : null;
    },
    getProviderAuthRefreshPromise(providerId) {
      return getProviderAuthRuntimeState(providerStates, providerId)
        .refreshPromise;
    },
    setProviderAuthRefreshPromise(promise, providerId) {
      getProviderAuthRuntimeState(providerStates, providerId).refreshPromise =
        promise;
    },
    async persistProviderCredential(credential, providerId) {
      await writeProviderAuthFile(
        credential,
        resolveProviderAuthCredentialProviderId(providerId),
      );
      this.setCachedProviderCredential(credential, providerId);
      this.setCachedProviderAuthLoadError(null, providerId);
      this.setCachedProviderAuthRefreshError(null, providerId);
      this.setHydratedProviderAuth(true, providerId);
    },
    clearProviderAuthRuntimeState(providerId) {
      if (providerId === undefined) {
        providerStates.clear();
        return;
      }
      providerStates.delete(providerId);
    },
  };
}

function getProviderAuthRuntimeState(
  providerStates: Map<
    ProviderAuthCredentialProviderId,
    ProviderAuthRuntimeProviderState
  >,
  providerId?: ProviderAuthCredentialProviderId,
): ProviderAuthRuntimeProviderState {
  const resolvedProviderId =
    resolveProviderAuthCredentialProviderId(providerId);
  const existing = providerStates.get(resolvedProviderId);
  if (existing) {
    return existing;
  }

  const created = createProviderAuthRuntimeProviderState();
  providerStates.set(resolvedProviderId, created);
  return created;
}

function createProviderAuthRuntimeProviderState(): ProviderAuthRuntimeProviderState {
  return {
    cachedCredential: null,
    refreshPromise: null,
    cachedLoadError: null,
    cachedRefreshError: null,
    hydratedProviderAuth: false,
  };
}
