import type { GenericApiErrorCode } from '../../error-codes.js';

/**
 * Provider 실패 클래스의 단일 owner.
 *
 * 하나의 실패 클래스는 네 가지 정체성을 동시에 갖는다: 내부 카테고리 id,
 * 이 클래스로 수렴하는 provider 코드 문자열들, 사용자에게 나가는 와이어 코드,
 * 그리고 소비하는 재시도 예산. 이 넷이 서로 다른 파일의 switch 문으로 흩어져
 * 있으면 클래스를 하나 추가할 때마다 같은 지식을 네 곳에 복제해야 하고,
 * 한 곳을 빼먹으면 실패가 다른 코드로 뭉개진 채 사용자에게 나간다.
 *
 * 그래서 클래스 추가/변경은 이 표 한 곳에서만 한다.
 */
export type StreamErrorCategory =
  | 'llm_idle_timeout'
  | 'llm_connection_lost'
  | 'llm_tls_verification_failed'
  | 'llm_overloaded'
  | 'llm_rate_limited'
  | 'llm_usage_limit_exceeded'
  | 'llm_auth_expired'
  | 'llm_context_overflow'
  | 'llm_output_budget_exceeded'
  | 'llm_replay_state_rejected'
  | 'llm_context_preparation_required'
  | 'llm_provider_transition_required'
  | 'oversize_input'
  | 'llm_refused'
  | 'abort_user'
  | 'abort_budget'
  | 'unknown';

/**
 * 이 클래스가 쓰는 재시도 예산. `null`은 같은 요청을 다시 보내도 결정적으로
 * 다시 실패한다는 뜻이며, 재시도 예산을 소비하지 않고 종료한다.
 *
 * 예산 값 자체는 provider 설정 owner가 갖는다. 이 표는 어떤 예산을 쓰는지만
 * 가리켜서, 정책 숫자와 분류 지식이 서로 섞이지 않게 한다.
 */
type ProviderFailureRetryBudget =
  | 'llmConnectionLost'
  | 'llmOverloaded'
  | 'llmRateLimited'
  | null;

interface ProviderFailureClass {
  category: StreamErrorCategory;
  /**
   * `normalizeProviderErrorCode`가 돌려주는 코드 중 이 클래스로 수렴하는 것들.
   * 카테고리 id 자체도 provider 코드로 들어올 수 있어 함께 등록한다.
   */
  providerCodes: readonly string[];
  /**
   * 사용자에게 나가는 와이어 코드. `null`은 코드를 표에서 정할 수 없고 실제
   * 오류에서 끌어와야 하는 경우(`unknown`)를 뜻한다.
   */
  wireCode: GenericApiErrorCode | null;
  message: string;
  retryBudget: ProviderFailureRetryBudget;
}

export const PROVIDER_FAILURE_CLASSES = [
  {
    category: 'llm_idle_timeout',
    providerCodes: ['llm_idle_timeout'],
    wireCode: 'llm_idle_timeout',
    message: 'provider request timed out',
    retryBudget: 'llmConnectionLost',
  },
  {
    category: 'llm_connection_lost',
    providerCodes: ['llm_connection_lost', 'llm_connect_timeout'],
    wireCode: 'llm_connect_timeout',
    message: 'provider request timed out',
    retryBudget: 'llmConnectionLost',
  },
  {
    // 재시도해도 같은 handshake 실패가 반복되므로 예산을 태우지 않는다.
    // 사용자가 손댈 수 있는 곳(CA bundle, TLS 검사 프록시)을 메시지로 알린다.
    category: 'llm_tls_verification_failed',
    providerCodes: ['llm_tls_verification_failed'],
    wireCode: 'llm_tls_verification_failed',
    message:
      'provider TLS certificate verification failed; check the system CA bundle or a TLS-inspecting proxy',
    retryBudget: null,
  },
  {
    category: 'llm_overloaded',
    providerCodes: ['llm_overloaded'],
    wireCode: 'llm_rate_limited',
    message: 'provider overloaded',
    retryBudget: 'llmOverloaded',
  },
  {
    category: 'llm_rate_limited',
    providerCodes: [
      'llm_rate_limited',
      'rate_limit_exceeded',
      'resource_exhausted',
      'throttled',
    ],
    wireCode: 'llm_rate_limited',
    message: 'provider rate limited',
    retryBudget: 'llmRateLimited',
  },
  {
    // 크레딧·구독·쿼터 소진. 일시 rate-limit과 달리 재시도 금지.
    // Grok(xAI) spending-limit 코드, OpenAI insufficient_quota 등.
    category: 'llm_usage_limit_exceeded',
    providerCodes: [
      'llm_usage_limit_exceeded',
      'insufficient_quota',
      'insufficient_credits',
      'billing_not_active',
      'payment_required',
      'no_usable_credits',
      'balance_depleted',
      'personal-team-blocked:spending-limit',
    ],
    wireCode: 'llm_usage_limit_exceeded',
    message:
      'provider usage or credit limit exceeded; top up or change plan (this is not a transient rate limit)',
    retryBudget: null,
  },
  {
    category: 'llm_auth_expired',
    providerCodes: ['llm_auth_expired', 'llm_auth_failed'],
    wireCode: 'llm_auth_failed',
    message: 'provider authentication failed',
    retryBudget: null,
  },
  {
    category: 'llm_context_overflow',
    providerCodes: ['llm_context_overflow', 'llm_context_length_exceeded'],
    wireCode: 'llm_context_length_exceeded',
    message: 'context length exceeded',
    retryBudget: null,
  },
  {
    // qwen_token_plan HTTP SSE chat completions가 max_tokens를 보낼 때만
    // 성립하는 거절. Codex/Grok Responses WS 본문에는 그 필드를 넣지 않는다.
    // 압축으로는 풀리지 않는다 — 같은 max_tokens로 결정적으로 다시 실패한다.
    category: 'llm_output_budget_exceeded',
    providerCodes: ['llm_output_budget_exceeded'],
    wireCode: 'llm_output_budget_exceeded',
    message:
      'output token budget exceeded; lower max_tokens (this is not an input context overflow)',
    retryBudget: null,
  },
  {
    // Responses WS: 이전 턴 encrypted reasoning blob 검증 실패.
    // context overflow 문구와 겹칠 수 있어 별도 클래스. 재시도 예산 없음 —
    // blob을 벗긴 뒤의 1회 재시도는 model-round owner가 맡는다.
    category: 'llm_replay_state_rejected',
    providerCodes: ['llm_replay_state_rejected', 'invalid_encrypted_content'],
    wireCode: 'llm_replay_state_rejected',
    message: 'provider rejected encrypted reasoning replay',
    retryBudget: null,
  },
  {
    category: 'llm_context_preparation_required',
    providerCodes: ['llm_context_preparation_required'],
    wireCode: 'llm_context_length_exceeded',
    message: 'context preparation required',
    retryBudget: null,
  },
  {
    category: 'llm_provider_transition_required',
    providerCodes: [
      'llm_provider_transition_required',
      'provider_transition_required',
    ],
    wireCode: 'provider_transition_required',
    message: 'provider transition requires a portable context handoff',
    retryBudget: null,
  },
  {
    category: 'oversize_input',
    providerCodes: ['oversize_input'],
    wireCode: 'llm_context_length_exceeded',
    message: 'input exceeds retry budget',
    retryBudget: null,
  },
  {
    category: 'llm_refused',
    providerCodes: ['llm_refused'],
    wireCode: 'execution_failed',
    message: 'model refused the request',
    retryBudget: null,
  },
  {
    category: 'abort_user',
    providerCodes: ['abort_user', 'aborted'],
    wireCode: 'aborted',
    message: 'run cancelled',
    retryBudget: null,
  },
  {
    category: 'abort_budget',
    providerCodes: ['abort_budget'],
    wireCode: 'execution_failed',
    message: 'run budget exceeded',
    retryBudget: null,
  },
  {
    // 분류에 실패한 경우. 와이어 코드는 실제 오류에서 끌어와야 하므로 표에서
    // 정하지 않는다.
    category: 'unknown',
    providerCodes: [],
    wireCode: null,
    message: 'provider request failed',
    retryBudget: null,
  },
] as const satisfies ReadonlyArray<ProviderFailureClass>;

const CLASS_BY_CATEGORY = new Map<string, ProviderFailureClass>(
  PROVIDER_FAILURE_CLASSES.map((failureClass) => [
    failureClass.category,
    failureClass,
  ]),
);

const CLASS_BY_PROVIDER_CODE = new Map<string, ProviderFailureClass>(
  PROVIDER_FAILURE_CLASSES.flatMap((failureClass) =>
    failureClass.providerCodes.map(
      (providerCode) => [providerCode, failureClass] as const,
    ),
  ),
);

export const STREAM_ERROR_CATEGORY_VALUES = PROVIDER_FAILURE_CLASSES.map(
  (failureClass) => failureClass.category,
);

export function resolveProviderFailureClass(
  category: StreamErrorCategory,
): ProviderFailureClass {
  const failureClass = CLASS_BY_CATEGORY.get(category);
  if (failureClass === undefined) {
    // 표가 카테고리 union을 모두 덮는지는 `satisfies`와 테스트가 보장한다.
    // 여기까지 오면 표가 union보다 좁아진 것이므로 조용히 넘기지 않는다.
    throw new Error(`provider failure class is not registered: ${category}`);
  }
  return failureClass;
}

export function findProviderFailureClassByProviderCode(
  providerCode: string,
): ProviderFailureClass | undefined {
  return CLASS_BY_PROVIDER_CODE.get(providerCode);
}

export function isStreamErrorCategory(
  value: string,
): value is StreamErrorCategory {
  return CLASS_BY_CATEGORY.has(value);
}
