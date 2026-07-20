import {
  DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
  readProviderAuthFile,
  type ProviderAuthCredentialProviderId,
  type ProviderCredential,
} from './credentials/store.js';
import type { ProviderAuthRuntimeStore } from './runtime-state.js';
import { getGenericApiErrorCode, getErrorMessage } from '../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { INVALID_PROVIDER_CREDENTIAL_MESSAGE } from './shared.js';

const logger = createLogger('provider-auth');

/** Load provider credential from disk into memory. Call once at daemon start. */
export async function initProviderAuth(options: {
  providerId?: ProviderAuthCredentialProviderId;
  readCredential?: () => Promise<ProviderCredential | null>;
  runtimeStore: ProviderAuthRuntimeStore;
}): Promise<void> {
  const providerId =
    options.providerId ?? DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID;
  const readCredential =
    options.readCredential ?? (() => readProviderAuthFile(providerId));
  const { runtimeStore } = options;
  try {
    runtimeStore.setCachedProviderCredential(
      await readCredential(),
      providerId,
    );
    runtimeStore.setCachedProviderAuthLoadError(null, providerId);
    runtimeStore.setCachedProviderAuthRefreshError(null, providerId);
    runtimeStore.setHydratedProviderAuth(true, providerId);
  } catch (err: unknown) {
    const code = getGenericApiErrorCode(err) ?? 'provider_auth_invalid';
    const message =
      code === 'provider_auth_invalid'
        ? INVALID_PROVIDER_CREDENTIAL_MESSAGE
        : getErrorMessage(err);
    runtimeStore.setCachedProviderCredential(null, providerId);
    runtimeStore.setCachedProviderAuthLoadError(
      {
        code,
        message,
      },
      providerId,
    );
    runtimeStore.setCachedProviderAuthRefreshError(null, providerId);
    runtimeStore.setHydratedProviderAuth(true, providerId);
    logger.warn('Credential load failed:', getErrorMessage(err));
  }
  if (runtimeStore.getCachedProviderCredential(providerId)) {
    logger.info('Credential loaded from file');
  } else if (runtimeStore.getCachedProviderAuthLoadError(providerId)) {
    logger.warn(
      'Provider credential load failed:',
      runtimeStore.getCachedProviderAuthLoadError(providerId)?.message,
    );
  } else {
    logger.warn('No credential file found');
  }
}
