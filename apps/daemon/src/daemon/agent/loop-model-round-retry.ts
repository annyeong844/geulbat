import { createLogger } from '@geulbat/structured-logger/logger';

import {
  coerceGenericApiErrorCode,
  type GenericApiErrorCode,
} from '../error-codes.js';
import type { StreamErrorCategory } from '../llm/provider/transport/stream-error.js';
import { resolveProviderFailureClass } from '../llm/provider/provider-failure-class.js';
import { getErrorCode } from '../utils/error.js';
import { calculateRetryDelayMs } from '../utils/retry.js';
import type { ProviderModelRoundRetryPolicy } from '../llm/provider/provider-options.js';
import type { AgentResult } from './agent-result.js';
import type { AgentEventEmitter } from './events.js';
import { emitTerminalFailure } from './loop-shared.js';

const logger = createLogger('agent/model-round');

type ModelRoundRetryDecision =
  | { kind: 'retry'; delayMs: number }
  | {
      kind: 'terminal';
      reason: 'unsafe_after_output' | 'exhausted' | 'unavailable';
    };

export function decideModelRoundRetry(args: {
  category: StreamErrorCategory;
  attemptIndex: number;
  sawSemanticChunk: boolean;
  policy: ProviderModelRoundRetryPolicy;
}): ModelRoundRetryDecision {
  if (args.sawSemanticChunk) {
    return { kind: 'terminal', reason: 'unsafe_after_output' };
  }
  const rule = getModelRoundRetryRule(args.policy, args.category);
  if (!rule) {
    return { kind: 'terminal', reason: 'unavailable' };
  }
  if (args.attemptIndex >= rule.maxRetries) {
    return { kind: 'terminal', reason: 'exhausted' };
  }

  const delayMs = defaultModelRoundRetryDelayMs({
    category: args.category,
    attemptIndex: args.attemptIndex,
    policy: args.policy,
  });
  logger.warn('retrying model round after retryable stream error', {
    attemptIndex: args.attemptIndex,
    category: args.category,
    delayMs,
  });
  return { kind: 'retry', delayMs };
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

function getModelRoundRetryRule(
  policy: ProviderModelRoundRetryPolicy,
  category: StreamErrorCategory,
): { maxRetries: number } | null {
  const { retryBudget } = resolveProviderFailureClass(category);
  return retryBudget === null ? null : policy[retryBudget];
}

function defaultModelRoundRetryDelayMs(args: {
  category: StreamErrorCategory;
  attemptIndex: number;
  policy: ProviderModelRoundRetryPolicy;
}): number {
  const rule = getModelRoundRetryRule(args.policy, args.category);
  if (!rule) {
    return 0;
  }
  return calculateRetryDelayMs({
    attemptIndex: args.attemptIndex,
    baseDelayMs: args.policy.delay.baseDelayMs,
    multiplier: args.policy.delay.multiplier,
    maxDelayMs: args.policy.delay.maxDelayMs,
    jitterRatio: args.policy.delay.jitterRatio,
  });
}

function streamErrorCategoryToErrorCode(
  category: StreamErrorCategory,
  error: unknown,
): GenericApiErrorCode {
  const { wireCode } = resolveProviderFailureClass(category);
  // 표가 코드를 정하지 못하는 클래스는 분류 실패뿐이다. 그 경우에만 실제
  // 오류에서 코드를 끌어온다.
  return wireCode ?? coerceGenericApiErrorCode(getErrorCode(error), 'internal');
}

function streamErrorCategoryToMessage(category: StreamErrorCategory): string {
  return resolveProviderFailureClass(category).message;
}
