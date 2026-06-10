import type { ProviderCredential } from './credentials/store.js';
import { readProviderAuthFile } from './credentials/store.js';
import type { ProviderAuthRuntimeStore } from './runtime-state.js';
import { getGenericApiErrorCode, getErrorMessage } from '../utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { INVALID_PROVIDER_CREDENTIAL_MESSAGE } from './shared.js';

const logger = createLogger('provider-auth');

/** Load provider credential from disk into memory. Call once at daemon start. */
export async function initProviderAuth(options: {
  readCredential?: () => Promise<ProviderCredential | null>;
  runtimeStore: ProviderAuthRuntimeStore;
}): Promise<void> {
  const readCredential = options?.readCredential ?? readProviderAuthFile;
  const { runtimeStore } = options;
  try {
    runtimeStore.setCachedProviderCredential(await readCredential());
    runtimeStore.setCachedProviderAuthLoadError(null);
    runtimeStore.setCachedProviderAuthRefreshError(null);
    runtimeStore.setHydratedProviderAuth(true);
  } catch (err: unknown) {
    const code = getGenericApiErrorCode(err) ?? 'provider_auth_invalid';
    const message =
      code === 'provider_auth_invalid'
        ? INVALID_PROVIDER_CREDENTIAL_MESSAGE
        : getErrorMessage(err);
    runtimeStore.setCachedProviderCredential(null);
    runtimeStore.setCachedProviderAuthLoadError({
      code,
      message,
    });
    runtimeStore.setCachedProviderAuthRefreshError(null);
    runtimeStore.setHydratedProviderAuth(true);
    logger.warn('Credential load failed:', getErrorMessage(err));
  }
  if (runtimeStore.getCachedProviderCredential()) {
    logger.info('Credential loaded from file');
  } else if (runtimeStore.getCachedProviderAuthLoadError()) {
    logger.warn(
      'Provider credential load failed:',
      runtimeStore.getCachedProviderAuthLoadError()?.message,
    );
  } else {
    logger.warn('No credential file found');
  }
}
