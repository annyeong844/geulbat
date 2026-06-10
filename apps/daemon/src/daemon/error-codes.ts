import {
  ERROR_CODES as PROTOCOL_ERROR_CODES,
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

const ERROR_CODE_SET = new Set<ErrorCode>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value as ErrorCode);
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
      return 400;
    case 'persistence_quota_exceeded':
      return 413;
    case 'unauthorized':
      return 401;
    case 'approval_required':
    case 'approval_denied':
    case 'approval_aborted':
    case 'path_out_of_workspace':
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
    case 'conflict_stale_write':
    case 'conflict_active_run':
    case 'persistence_conflict':
    case 'provider_auth_already_connected':
      return 409;
    case 'llm_rate_limited':
    case 'rate_limited':
      return 429;
    case 'llm_auth_failed':
    case 'provider_auth_exchange_failed':
    case 'provider_auth_account_id_missing':
    case 'provider_auth_refresh_failed':
      return 502;
    case 'index_not_ready':
    case 'provider_auth_not_configured':
    case 'provider_auth_callback_unavailable':
    case 'persistence_unavailable':
      return 503;
    case 'approval_timeout':
    case 'timeout':
    case 'llm_connect_timeout':
    case 'llm_idle_timeout':
    case 'provider_auth_exchange_timeout':
      return 504;
    case 'provider_auth_write_failed':
    case 'execution_failed':
    case 'internal':
      return 500;
    case 'not_implemented':
    case 'persistence_unsupported':
      return 501;
  }

  const _exhaustive: never = code;
  return _exhaustive;
}
