import {
  ERROR_CODES as PROTOCOL_ERROR_CODES,
  isErrorCode as isProtocolErrorCode,
  isGenericApiErrorCode as isProtocolGenericApiErrorCode,
} from '@geulbat/protocol/errors';
import type {
  ErrorCode as ProtocolErrorCode,
  GenericApiError as ProtocolGenericApiError,
  GenericApiErrorCode as ProtocolGenericApiErrorCode,
} from '@geulbat/protocol/errors';

export type ErrorCode = ProtocolErrorCode;
export type GenericApiError = ProtocolGenericApiError;
export type GenericApiErrorCode = ProtocolGenericApiErrorCode;

export const ERROR_CODES = PROTOCOL_ERROR_CODES;

export function isErrorCode(value: unknown): value is ErrorCode {
  return isProtocolErrorCode(value);
}

export function isGenericApiErrorCode(
  value: unknown,
): value is GenericApiErrorCode {
  return isProtocolGenericApiErrorCode(value);
}

export function coerceGenericApiErrorCode(
  value: unknown,
  fallback: GenericApiErrorCode = 'execution_failed',
): GenericApiErrorCode {
  return isGenericApiErrorCode(value) ? value : fallback;
}

export function errorCodeToStatus(code: ErrorCode): number {
  switch (code) {
    case 'bad_request':
    case 'invalid_path':
    case 'invalid_args':
    case 'binary_file':
    case 'buffer_limit_exceeded':
    case 'unsupported_mode':
    case 'llm_context_length_exceeded':
    // 출력 상한 거절도 요청 shape 문제(400)다. 입력 컨텍스트 초과와 HTTP
    // 의미는 같지만 복구 경로가 다르므로 코드는 분리한다.
    case 'llm_output_budget_exceeded':
    // encrypted reasoning replay 거절도 요청 내용 문제(400).
    case 'llm_replay_state_rejected':
      return 400;
    case 'persistence_quota_exceeded':
      return 413;
    case 'unauthorized':
      return 401;
    case 'approval_required':
    case 'approval_denied':
    case 'approval_aborted':
    case 'path_out_of_computer_scope':
    case 'access_denied':
    case 'persistence_blocked':
      return 403;
    case 'provider_auth_session_not_found':
    case 'not_found':
    case 'unknown_tool':
      return 404;
    case 'provider_auth_session_expired':
    case 'provider_auth_invalid':
      return 410;
    case 'already_exists':
    case 'conflict':
    case 'aborted':
    case 'provider_transition_required':
    case 'conflict_stale_write':
    case 'conflict_active_run':
    case 'llm_provider_request_outcome_unknown':
    case 'persistence_conflict':
    case 'provider_auth_already_connected':
    // 무진전은 서버 오류가 아니라 같은 상태가 반복돼 진행이 막힌 것이다.
    // 재시도 자체가 아니라 목표·증거·권한 중 하나가 바뀌어야 풀린다.
    case 'run_no_progress':
      return 409;
    case 'provider_transition_preparation_failed':
      return 422;
    case 'llm_rate_limited':
    case 'rate_limited':
    case 'quota_exceeded':
      return 429;
    // 크레딧/구독 소진 — 일시 429 스로틀과 구분한다.
    case 'llm_usage_limit_exceeded':
      return 402;
    case 'llm_auth_failed':
    // 신뢰할 수 있는 연결 자체를 세우지 못한 경우다. 우리 요청이 잘못된 것이
    // 아니라 provider까지 가는 경로가 검증되지 않았다.
    case 'llm_tls_verification_failed':
    case 'provider_auth_exchange_failed':
    case 'provider_auth_account_id_missing':
    case 'provider_auth_refresh_failed':
    case 'invalid_image_response':
      return 502;
    case 'index_not_ready':
    case 'provider_auth_not_configured':
    case 'provider_auth_callback_unavailable':
    case 'persistence_unavailable':
    case 'image_provider_unavailable':
      return 503;
    case 'approval_timeout':
    case 'timeout':
    case 'llm_connect_timeout':
    case 'llm_idle_timeout':
    case 'provider_auth_exchange_timeout':
      return 504;
    case 'provider_auth_write_failed':
    case 'execution_failed':
    case 'artifact_commit_failed':
    case 'internal':
      return 500;
    case 'not_implemented':
    case 'persistence_unsupported':
      return 501;
  }

  const _exhaustive: never = code;
  return _exhaustive;
}
