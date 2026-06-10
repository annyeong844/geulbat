import { createLogger } from '@geulbat/shared-utils/logger';

import {
  coerceGenericApiErrorCode,
  type GenericApiErrorCode,
} from '../error-codes.js';
import type { StreamErrorCategory } from '../llm/provider/transport/stream-error.js';
import { getErrorCode } from '../utils/error.js';
import { calculateRetryDelayMs } from '../utils/retry.js';
import type { AgentResult } from './agent-result.js';
import type { AgentEventEmitter } from './events.js';
import { emitTerminalFailure } from './loop-shared.js';

const logger = createLogger('agent/model-round');
const MODEL_ROUND_RETRY_MAX_DELAY_MS = 4_000;
const MODEL_ROUND_RETRY_JITTER_RATIO = 0.2;

interface ModelRoundRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
}

export function decideModelRoundRetry(args: {
  category: StreamErrorCategory;
  attemptIndex: number;
  sawSemanticChunk: boolean;
}): { delayMs: number } | null {
  if (args.sawSemanticChunk) {
    return null;
  }
  const policy = getModelRoundRetryPolicy(args.category);
  if (!policy || args.attemptIndex >= policy.maxRetries) {
    return null;
  }

  const delayMs = defaultModelRoundRetryDelayMs({
    category: args.category,
    attemptIndex: args.attemptIndex,
  });
  logger.warn('retrying model round after retryable stream error', {
    attemptIndex: args.attemptIndex,
    category: args.category,
    delayMs,
  });
  return { delayMs };
}

export function emitClassifiedStreamError(
  emit: AgentEventEmitter,
  args: {
    category: StreamErrorCategory;
    error: unknown;
    message?: string;
  },
): AgentResult {
  return emitTerminalFailure(
    emit,
    streamErrorCategoryToErrorCode(args.category, args.error),
    args.message ?? streamErrorCategoryToMessage(args.category),
  );
}

export function sleepForModelRoundRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function getModelRoundRetryPolicy(
  category: StreamErrorCategory,
): ModelRoundRetryPolicy | null {
  switch (category) {
    case 'llm_connection_lost':
      return { maxRetries: 2, baseDelayMs: 1_000 };
    case 'llm_overloaded':
    case 'llm_rate_limited':
      return { maxRetries: 3, baseDelayMs: 1_000 };
    case 'llm_idle_timeout':
    case 'llm_auth_expired':
    case 'llm_context_overflow':
    case 'oversize_input':
    case 'llm_refused':
    case 'abort_user':
    case 'abort_budget':
    case 'unknown':
      return null;
  }
}

function defaultModelRoundRetryDelayMs(args: {
  category: StreamErrorCategory;
  attemptIndex: number;
}): number {
  const policy = getModelRoundRetryPolicy(args.category);
  if (!policy) {
    return 0;
  }
  return calculateRetryDelayMs({
    attemptIndex: args.attemptIndex,
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: MODEL_ROUND_RETRY_MAX_DELAY_MS,
    jitterRatio: MODEL_ROUND_RETRY_JITTER_RATIO,
  });
}

function streamErrorCategoryToErrorCode(
  category: StreamErrorCategory,
  error: unknown,
): GenericApiErrorCode {
  switch (category) {
    case 'llm_idle_timeout':
      return 'llm_idle_timeout';
    case 'llm_connection_lost':
      return 'llm_connect_timeout';
    case 'llm_overloaded':
    case 'llm_rate_limited':
      return 'llm_rate_limited';
    case 'llm_auth_expired':
      return 'llm_auth_failed';
    case 'llm_context_overflow':
    case 'oversize_input':
      return 'llm_context_length_exceeded';
    case 'abort_user':
      return 'aborted';
    case 'llm_refused':
    case 'abort_budget':
      return 'execution_failed';
    case 'unknown':
      return coerceGenericApiErrorCode(getErrorCode(error), 'internal');
  }
}

function streamErrorCategoryToMessage(category: StreamErrorCategory): string {
  switch (category) {
    case 'llm_idle_timeout':
    case 'llm_connection_lost':
      return 'provider request timed out';
    case 'llm_overloaded':
      return 'provider overloaded';
    case 'llm_rate_limited':
      return 'provider rate limited';
    case 'llm_auth_expired':
      return 'provider authentication failed';
    case 'llm_context_overflow':
      return 'context length exceeded';
    case 'oversize_input':
      return 'input exceeds retry budget';
    case 'llm_refused':
      return 'model refused the request';
    case 'abort_user':
      return 'run cancelled';
    case 'abort_budget':
      return 'run budget exceeded';
    case 'unknown':
      return 'provider request failed';
  }
}
