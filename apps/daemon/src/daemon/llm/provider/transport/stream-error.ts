import {
  getErrorCode,
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../../utils/error.js';
import { normalizeProviderErrorCode } from '../provider-error.js';

export type StreamErrorCategory =
  | 'llm_idle_timeout'
  | 'llm_connection_lost'
  | 'llm_overloaded'
  | 'llm_rate_limited'
  | 'llm_auth_expired'
  | 'llm_context_overflow'
  | 'oversize_input'
  | 'llm_refused'
  | 'abort_user'
  | 'abort_budget'
  | 'unknown';

const STREAM_ERROR_CATEGORY_VALUES = [
  'llm_idle_timeout',
  'llm_connection_lost',
  'llm_overloaded',
  'llm_rate_limited',
  'llm_auth_expired',
  'llm_context_overflow',
  'oversize_input',
  'llm_refused',
  'abort_user',
  'abort_budget',
  'unknown',
] as const satisfies ReadonlyArray<StreamErrorCategory>;

export function classifyStreamError(error: unknown): StreamErrorCategory {
  const explicitCategory = readExplicitStreamErrorCategory(error);
  if (explicitCategory) {
    return explicitCategory;
  }

  const explicitProviderCode = readExplicitProviderErrorCode(error);
  if (explicitProviderCode) {
    const explicitProviderCategory =
      mapProviderCodeToStreamErrorCategory(explicitProviderCode);
    if (explicitProviderCategory !== 'unknown') {
      return explicitProviderCategory;
    }
  }

  const providerCode = normalizeProviderErrorCode(error);
  const providerCategory = mapProviderCodeToStreamErrorCategory(providerCode);
  if (providerCategory !== 'unknown') {
    return providerCategory;
  }

  const statusCategory = readStatusStreamErrorCategory(error);
  if (statusCategory) {
    return statusCategory;
  }

  if (!(error instanceof Error)) {
    return 'unknown';
  }

  return readMessageStreamErrorCategory(error) ?? 'unknown';
}

function isStreamErrorCategory(value: string): value is StreamErrorCategory {
  return STREAM_ERROR_CATEGORY_VALUES.some((category) => category === value);
}

function readExplicitStreamErrorCategory(
  error: unknown,
): StreamErrorCategory | null {
  const llmCode = getErrorStringProperty(error, 'llmCode');
  if (llmCode && isStreamErrorCategory(llmCode)) {
    return llmCode;
  }

  const code = getErrorCode(error);
  if (code && isStreamErrorCategory(code)) {
    return code;
  }

  return null;
}

function readExplicitProviderErrorCode(error: unknown): string | null {
  return (
    getErrorStringProperty(error, 'llmCode') ?? getErrorCode(error) ?? null
  );
}

function mapProviderCodeToStreamErrorCategory(
  code: string,
): StreamErrorCategory {
  switch (code) {
    case 'aborted':
      return 'abort_user';
    case 'llm_idle_timeout':
      return 'llm_idle_timeout';
    case 'llm_connect_timeout':
      return 'llm_connection_lost';
    case 'llm_rate_limited':
      return 'llm_rate_limited';
    case 'llm_auth_failed':
      return 'llm_auth_expired';
    case 'llm_context_length_exceeded':
      return 'llm_context_overflow';
    case 'llm_connection_lost':
    case 'llm_overloaded':
    case 'llm_auth_expired':
    case 'llm_context_overflow':
    case 'oversize_input':
    case 'llm_refused':
    case 'abort_user':
    case 'abort_budget':
      return code;
    default:
      return 'unknown';
  }
}

function readStatusStreamErrorCategory(
  error: unknown,
): StreamErrorCategory | null {
  const status = getErrorNumberProperty(error, 'status');
  if (status === 529) {
    return 'llm_overloaded';
  }
  return null;
}

function readMessageStreamErrorCategory(
  error: Error,
): StreamErrorCategory | null {
  const message = error.message.toLowerCase();
  const code = getErrorCode(error);

  if (error.name === 'AbortError' || code === 'ABORT_ERR') {
    return 'abort_user';
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') {
    return 'llm_connection_lost';
  }
  if (
    message.includes('connection lost') ||
    message.includes('connection closed') ||
    message.includes('connection refused') ||
    message.includes('socket hang up') ||
    message.includes('websocket closed')
  ) {
    return 'llm_connection_lost';
  }
  if (
    message.includes('overloaded') ||
    message.includes('over capacity') ||
    message.includes('temporarily unavailable')
  ) {
    return 'llm_overloaded';
  }
  if (
    message.includes('content policy') ||
    message.includes('model refused') ||
    message.includes('response refused')
  ) {
    return 'llm_refused';
  }

  return null;
}
