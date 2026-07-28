import {
  getErrorCode,
  getErrorNumberProperty,
  getErrorStringProperty,
} from '../../utils/error.js';
import {
  findProviderFailureClassByProviderCode,
  resolveProviderFailureClass,
} from './provider-failure-class.js';

/** Map provider HTTP status / error shape to protocol-compatible llm_* error codes. */
export function normalizeProviderErrorCode(err: unknown): string {
  const explicitCode = readExplicitProviderErrorCode(err);
  if (explicitCode) {
    return explicitCode;
  }

  // Responses WS 등은 provider 원 코드를 `providerErrorCode`로 남긴다.
  // failure-class 표에 등록된 코드만 여기서 수렴한다.
  const structuredProviderCode = readStructuredProviderErrorCode(err);
  if (structuredProviderCode !== null) {
    const mapped = findProviderFailureClassByProviderCode(
      structuredProviderCode,
    );
    if (mapped !== undefined) {
      return mapped.wireCode ?? mapped.category;
    }
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

/**
 * 사용자에게 나갈 메시지는 provider 원문을 그대로 흘리지 않고 실패 클래스
 * owner 표에서 가져온다. 표에 없는 코드는 클래스가 정해지지 않은 것이므로
 * `unknown` 클래스의 메시지를 쓴다.
 */
export function sanitizeProviderErrorMessage(code: string): string {
  return (
    findProviderFailureClassByProviderCode(code) ??
    resolveProviderFailureClass('unknown')
  ).message;
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

function readStructuredProviderErrorCode(err: unknown): string | null {
  const providerErrorCode = getErrorStringProperty(err, 'providerErrorCode');
  if (providerErrorCode !== undefined && providerErrorCode.trim() !== '') {
    return providerErrorCode;
  }
  const code = getErrorCode(err);
  if (code !== undefined && findProviderFailureClassByProviderCode(code)) {
    return code;
  }
  return null;
}

function readProviderStatusErrorCode(
  err: Error,
  message: string,
): string | null {
  const status = getErrorNumberProperty(err, 'status');
  if (status === undefined) {
    return null;
  }
  if (status === 401) {
    return 'llm_auth_failed';
  }
  // Grok(xAI) 크레딧 소진은 403 + spending-limit 코드/문구로 온다.
  // 일반 403 auth 와 구분한다.
  if (status === 403) {
    if (
      isUsageLimitExhaustedMessage(message) ||
      isGrokSpendingLimitError(err)
    ) {
      return 'llm_usage_limit_exceeded';
    }
    return 'llm_auth_failed';
  }
  if (status === 402) {
    // 402 + "try again later" 형태는 일시 usage window → rate-limit.
    if (isUsageLimitMessage(message) && isTransientUsageLimitMessage(message)) {
      return 'llm_rate_limited';
    }
    return 'llm_usage_limit_exceeded';
  }
  if (status === 429) {
    // 소진 확정 문구면 rate-limit 재시도 예산을 태우지 않는다.
    if (
      isUsageLimitExhaustedMessage(message) &&
      !isTransientUsageLimitMessage(message)
    ) {
      return 'llm_usage_limit_exceeded';
    }
    return 'llm_rate_limited';
  }
  if (status === 400 && isInvalidEncryptedContentMessage(message)) {
    return 'llm_replay_state_rejected';
  }
  if (status === 400 && isOutputBudgetExceededMessage(message)) {
    return 'llm_output_budget_exceeded';
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
  // encrypted replay 거절은 context overflow보다 먼저 (문구가 겹칠 수 있음).
  if (isInvalidEncryptedContentMessage(message)) {
    return 'llm_replay_state_rejected';
  }
  // 소진 vs 일시 rate-limit: 소진·usage window 문구를 rate limit 일반 문구보다 먼저.
  if (isUsageLimitExhaustedMessage(message)) {
    if (isTransientUsageLimitMessage(message)) {
      return 'llm_rate_limited';
    }
    return 'llm_usage_limit_exceeded';
  }
  // "usage limit" + reset/retry → 일시 쿼터. 소진 확정 문구가 아니면 rate-limit.
  if (message.includes('usage limit')) {
    if (isTransientUsageLimitMessage(message)) {
      return 'llm_rate_limited';
    }
    return 'llm_usage_limit_exceeded';
  }
  if (message.includes('rate limit') || message.includes('rate_limit')) {
    return 'llm_rate_limited';
  }
  if (
    message.includes('too many requests') ||
    message.includes('requests per minute') ||
    message.includes('tokens per minute')
  ) {
    return 'llm_rate_limited';
  }
  if (message.includes('currently at capacity')) {
    return 'llm_overloaded';
  }
  // 출력 상한을 입력 overflow보다 먼저 본다.
  if (isOutputBudgetExceededMessage(message)) {
    return 'llm_output_budget_exceeded';
  }
  if (isContextLengthMessage(message)) {
    return 'llm_context_length_exceeded';
  }
  return null;
}

/**
 * 크레딧·구독·쿼터 **소진** (일시 스로틀 아님).
 * Codex/OpenAI·Grok(xAI)·Qwen(Aliyun) 공통 문구·코드만. OpenRouter 전용 없음.
 */
function isUsageLimitExhaustedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient balance') ||
    lower.includes('credit balance') ||
    lower.includes('credits exhausted') ||
    lower.includes('credits have been exhausted') ||
    lower.includes('no usable credits') ||
    lower.includes('top up your credits') ||
    lower.includes('payment required') ||
    lower.includes('billing hard limit') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('out of funds') ||
    lower.includes('run out of funds') ||
    lower.includes('balance_depleted') ||
    lower.includes('spending-limit') ||
    lower.includes('spending limit') ||
    lower.includes('personal-team-blocked')
  );
}

function isUsageLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('usage limit') ||
    lower.includes('quota') ||
    lower.includes('limit exceeded')
  );
}

/**
 * usage/quota 문구이지만 창이 리셋되는 일시 한도.
 * "try again in 5 minutes" 류 → rate-limit 재시도 유지.
 */
function isTransientUsageLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('try again') ||
    lower.includes('retry') ||
    lower.includes('resets at') ||
    lower.includes('reset in') ||
    lower.includes('please wait') ||
    lower.includes('retry after') ||
    lower.includes('please retry after')
  );
}

function isGrokSpendingLimitError(err: Error): boolean {
  const providerErrorCode =
    getErrorStringProperty(err, 'providerErrorCode')?.toLowerCase() ?? '';
  return (
    providerErrorCode === 'personal-team-blocked:spending-limit' ||
    providerErrorCode.includes('spending-limit')
  );
}

/**
 * Responses WS encrypted reasoning blob 검증 실패.
 * context overflow 휴리스틱보다 먼저 써야 한다.
 */
function isInvalidEncryptedContentMessage(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('invalid_encrypted_content')) {
    return true;
  }
  if (
    lower.includes('encrypted content for item') &&
    lower.includes('could not be verified')
  ) {
    return true;
  }
  if (lower.includes('could not decrypt the provided encrypted_content')) {
    return true;
  }
  return false;
}

/**
 * 요청한 출력 토큰 상한이 모델 한도를 넘는 거절.
 *
 * 전송 경계를 섞지 않는다:
 * - qwen_token_plan 만 HTTP SSE chat completions로 `max_tokens`를 보낸다
 *   (요약 compaction 등). Aliyun compatible-mode 거절 문구만 여기서 본다.
 * - openai_codex_direct / grok_oauth 는 Responses WebSocket 본문에
 *   max_tokens / max_output_tokens 를 넣지 않는다.
 */
function isOutputBudgetExceededMessage(message: string): boolean {
  const lower = message.toLowerCase();
  // qwen_token_plan · Aliyun MaaS compatible-mode SSE chat completions only.
  return lower.includes('range of max_tokens should be');
}

function isContextLengthMessage(message: string): boolean {
  if (isOutputBudgetExceededMessage(message)) {
    return false;
  }
  if (isInvalidEncryptedContentMessage(message)) {
    return false;
  }
  const lower = message.toLowerCase();
  // 세 공급자 공통으로 쓰이는 입력 창 초과 신호만.
  return (
    (lower.includes('context') && lower.includes('length')) ||
    lower.includes('context_length_exceeded') ||
    lower.includes('prompt is too long') ||
    lower.includes('prompt too long') ||
    lower.includes('input is too long')
  );
}

export class ProviderReplayScopeMismatchError extends Error {
  readonly llmCode = 'llm_auth_failed';

  constructor() {
    super('provider replay state belongs to a different authentication scope');
    this.name = 'ProviderReplayScopeMismatchError';
  }
}
