import type { GenericApiError } from '../error-codes.js';
import type { ProviderCredential } from './credentials/store.js';
import { writeProviderAuthFile } from './credentials/store.js';

type ProviderAuthLoadError = GenericApiError;

export interface ProviderAuthRuntimeStore {
  hasHydratedProviderAuth(): boolean;
  setHydratedProviderAuth(hydrated: boolean): void;
  getCachedProviderCredential(): ProviderCredential | null;
  setCachedProviderCredential(credential: ProviderCredential | null): void;
  getCachedProviderAuthLoadError(): ProviderAuthLoadError | null;
  setCachedProviderAuthLoadError(error: ProviderAuthLoadError | null): void;
  getCachedProviderAuthRefreshError(): ProviderAuthLoadError | null;
  setCachedProviderAuthRefreshError(error: ProviderAuthLoadError | null): void;
  getProviderAuthRefreshPromise(): Promise<void> | null;
  setProviderAuthRefreshPromise(promise: Promise<void> | null): void;
  persistProviderCredential(credential: ProviderCredential): Promise<void>;
  clearProviderAuthRuntimeState(): void;
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
  let cachedCredential: ProviderCredential | null = null;
  let refreshPromise: Promise<void> | null = null;
  let cachedLoadError: ProviderAuthLoadError | null = null;
  let cachedRefreshError: ProviderAuthLoadError | null = null;
  let hydratedProviderAuth = false;

  return {
    hasHydratedProviderAuth() {
      return hydratedProviderAuth;
    },
    setHydratedProviderAuth(hydrated) {
      hydratedProviderAuth = hydrated;
    },
    getCachedProviderCredential() {
      return cachedCredential
        ? cloneProviderCredential(cachedCredential)
        : null;
    },
    setCachedProviderCredential(credential) {
      cachedCredential = credential
        ? cloneProviderCredential(credential)
        : null;
    },
    getCachedProviderAuthLoadError() {
      return cachedLoadError
        ? cloneProviderAuthLoadError(cachedLoadError)
        : null;
    },
    setCachedProviderAuthLoadError(error) {
      cachedLoadError = error ? cloneProviderAuthLoadError(error) : null;
    },
    getCachedProviderAuthRefreshError() {
      return cachedRefreshError
        ? cloneProviderAuthLoadError(cachedRefreshError)
        : null;
    },
    setCachedProviderAuthRefreshError(error) {
      cachedRefreshError = error ? cloneProviderAuthLoadError(error) : null;
    },
    getProviderAuthRefreshPromise() {
      return refreshPromise;
    },
    setProviderAuthRefreshPromise(promise) {
      refreshPromise = promise;
    },
    async persistProviderCredential(credential) {
      await writeProviderAuthFile(credential);
      this.setCachedProviderCredential(credential);
      this.setCachedProviderAuthLoadError(null);
      this.setCachedProviderAuthRefreshError(null);
      this.setHydratedProviderAuth(true);
    },
    clearProviderAuthRuntimeState() {
      hydratedProviderAuth = false;
      cachedCredential = null;
      refreshPromise = null;
      cachedLoadError = null;
      cachedRefreshError = null;
    },
  };
}
