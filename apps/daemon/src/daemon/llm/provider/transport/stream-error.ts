import {
  getErrorCode,
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../../utils/error.js';
import { normalizeProviderErrorCode } from '../provider-error.js';
import {
  findProviderFailureClassByProviderCode,
  isStreamErrorCategory,
  type StreamErrorCategory,
} from '../provider-failure-class.js';

export type { StreamErrorCategory };

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
  return findProviderFailureClassByProviderCode(code)?.category ?? 'unknown';
}

function readStatusStreamErrorCategory(
  error: unknown,
): StreamErrorCategory | null {
  const status = getErrorNumberProperty(error, 'status');
  // Qwen HTTP SSE는 본문 없이 status만 넘긴다. 503을 못 잡으면 unknown으로
  // 떨어져 같은 경로의 429만 재시도되는 비대칭이 생긴다.
  if (status === 503) {
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
