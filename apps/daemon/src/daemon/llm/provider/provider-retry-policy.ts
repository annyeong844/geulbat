import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from './provider-error.js';

type ProviderRetryAction = 'fail' | 'force_refresh_auth_retry';

interface ProviderRetryDecision {
  action: ProviderRetryAction;
  code: string;
  message: string;
}

const MAX_PROVIDER_AUTH_REFRESH_RETRIES = 1;

export function decideProviderRetryPolicy(args: {
  error: unknown;
  authRefreshAttempts: number;
}): ProviderRetryDecision {
  const code = normalizeProviderErrorCode(args.error);
  const message = sanitizeProviderErrorMessage(code);

  if (
    code === 'llm_auth_failed' &&
    args.authRefreshAttempts < MAX_PROVIDER_AUTH_REFRESH_RETRIES
  ) {
    return {
      action: 'force_refresh_auth_retry',
      code,
      message,
    };
  }

  return {
    action: 'fail',
    code,
    message,
  };
}
