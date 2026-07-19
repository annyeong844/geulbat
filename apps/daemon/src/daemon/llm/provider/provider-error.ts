import {
  getErrorCode,
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../utils/error.js';

/** Map provider HTTP status / error shape to protocol-compatible llm_* error codes. */
export function normalizeProviderErrorCode(err: unknown): string {
  const explicitCode = readExplicitProviderErrorCode(err);
  if (explicitCode) {
    return explicitCode;
  }

  const appCode = readCanonicalProviderAppErrorCode(err);
  if (appCode) {
    return appCode;
  }

  if (!(err instanceof Error)) {
    return 'internal';
  }

  const message = err.message.toLowerCase();
  const statusCode = readProviderStatusErrorCode(err, message);
  if (statusCode) {
    return statusCode;
  }

  return readProviderMessageErrorCode(message) ?? 'internal';
}

export function sanitizeProviderErrorMessage(code: string): string {
  switch (code) {
    case 'aborted':
      return 'run cancelled';
    case 'llm_auth_failed':
      return 'provider authentication failed';
    case 'llm_rate_limited':
      return 'provider rate limited';
    case 'llm_overloaded':
      return 'provider overloaded';
    case 'llm_context_length_exceeded':
      return 'context length exceeded';
    case 'llm_connect_timeout':
    case 'llm_idle_timeout':
      return 'provider request timed out';
    default:
      return 'provider request failed';
  }
}

function matchesProviderTimeoutMessage(message: string): boolean {
  return (
    /\bconnect timeout\b/.test(message) ||
    /\bconnection timed out\b/.test(message) ||
    /\brequest timed out\b/.test(message) ||
    /\bprovider request timed out\b/.test(message) ||
    /\betimedout\b/.test(message)
  );
}

function readExplicitProviderErrorCode(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }
  return getErrorStringProperty(err, 'llmCode') ?? null;
}

function readProviderStatusErrorCode(
  err: Error,
  message: string,
): string | null {
  const status = getErrorNumberProperty(err, 'status');
  if (status === undefined) {
    return null;
  }
  if (status === 401 || status === 403) {
    return 'llm_auth_failed';
  }
  if (status === 429) {
    return 'llm_rate_limited';
  }
  if (status === 400 && isContextLengthMessage(message)) {
    return 'llm_context_length_exceeded';
  }
  return null;
}

function readCanonicalProviderAppErrorCode(err: unknown): string | null {
  const appCode = getErrorCode(err);
  if (
    appCode === 'provider_auth_invalid' ||
    appCode === 'provider_auth_session_not_found'
  ) {
    return 'llm_auth_failed';
  }
  return null;
}

function readProviderMessageErrorCode(message: string): string | null {
  if (message.includes('aborted')) {
    return 'aborted';
  }
  if (matchesProviderTimeoutMessage(message)) {
    return 'llm_connect_timeout';
  }
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return 'llm_rate_limited';
  }
  if (message.includes('currently at capacity')) {
    return 'llm_overloaded';
  }
  if (isContextLengthMessage(message)) {
    return 'llm_context_length_exceeded';
  }
  return null;
}

function isContextLengthMessage(message: string): boolean {
  return message.includes('context') && message.includes('length');
}
