/**
 * Protocol error types — serializable JSON shape interfaces.
 * NOT runtime Error classes. These go directly on the wire.
 */

import { isRunId, isThreadId } from './ids.js';
import { isRecord, isString } from './runtime-utils.js';

export type ErrorCode =
  | 'persistence_unsupported'
  | 'persistence_blocked'
  | 'persistence_unavailable'
  | 'persistence_conflict'
  | 'persistence_quota_exceeded'
  | 'provider_auth_already_connected'
  | 'provider_auth_not_configured'
  | 'provider_auth_callback_unavailable'
  | 'provider_auth_session_not_found'
  | 'provider_auth_session_expired'
  | 'provider_auth_exchange_failed'
  | 'provider_auth_exchange_timeout'
  | 'provider_auth_account_id_missing'
  | 'provider_auth_write_failed'
  | 'provider_auth_invalid'
  | 'provider_auth_refresh_failed'
  | 'unknown_tool'
  | 'invalid_args'
  | 'approval_required'
  | 'approval_denied'
  | 'approval_aborted'
  | 'approval_timeout'
  | 'timeout'
  | 'aborted'
  | 'conflict'
  | 'conflict_stale_write'
  | 'conflict_active_run'
  | 'index_not_ready'
  | 'not_implemented'
  | 'bad_request'
  | 'llm_connect_timeout'
  | 'llm_idle_timeout'
  | 'llm_rate_limited'
  | 'llm_auth_failed'
  | 'llm_context_length_exceeded'
  | 'rate_limited'
  | 'invalid_path'
  | 'already_exists'
  | 'path_out_of_computer_scope'
  | 'access_denied'
  | 'binary_file'
  | 'buffer_limit_exceeded'
  | 'unsupported_mode'
  | 'execution_failed'
  | 'not_found'
  | 'unauthorized'
  | 'internal'
  // 이미지 생성 실패 분류(image-generation-open §4.4) — 사용자가 고른 이미지
  // 모델/프로바이더가 사용 불가(미연결·비활성·검증 미통과)면 자동 폴백 없이
  // 이 코드로 명시적으로 실패한다.
  | 'image_provider_unavailable'
  | 'quota_exceeded'
  | 'invalid_image_response'
  | 'artifact_commit_failed';

export const ERROR_CODES = [
  'persistence_unsupported',
  'persistence_blocked',
  'persistence_unavailable',
  'persistence_conflict',
  'persistence_quota_exceeded',
  'provider_auth_already_connected',
  'provider_auth_not_configured',
  'provider_auth_callback_unavailable',
  'provider_auth_session_not_found',
  'provider_auth_session_expired',
  'provider_auth_exchange_failed',
  'provider_auth_exchange_timeout',
  'provider_auth_account_id_missing',
  'provider_auth_write_failed',
  'provider_auth_invalid',
  'provider_auth_refresh_failed',
  'unknown_tool',
  'invalid_args',
  'approval_required',
  'approval_denied',
  'approval_aborted',
  'approval_timeout',
  'timeout',
  'aborted',
  'conflict',
  'conflict_stale_write',
  'conflict_active_run',
  'index_not_ready',
  'not_implemented',
  'bad_request',
  'llm_connect_timeout',
  'llm_idle_timeout',
  'llm_rate_limited',
  'llm_auth_failed',
  'llm_context_length_exceeded',
  'rate_limited',
  'invalid_path',
  'already_exists',
  'path_out_of_computer_scope',
  'access_denied',
  'binary_file',
  'buffer_limit_exceeded',
  'unsupported_mode',
  'execution_failed',
  'not_found',
  'unauthorized',
  'internal',
  'image_provider_unavailable',
  'quota_exceeded',
  'invalid_image_response',
  'artifact_commit_failed',
] as const satisfies ReadonlyArray<ErrorCode>;

export type GenericApiErrorCode = Exclude<
  ErrorCode,
  'conflict_stale_write' | 'conflict_active_run'
>;

export interface GenericApiError {
  code: GenericApiErrorCode;
  message: string;
}

export const PERSISTENCE_ERROR_CODES = [
  'persistence_unsupported',
  'persistence_blocked',
  'persistence_unavailable',
  'persistence_conflict',
  'persistence_quota_exceeded',
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export interface ConflictStaleWriteError {
  code: 'conflict_stale_write';
  message: string;
  path: string;
  currentVersionToken: string;
}

export interface ConflictActiveRunError {
  code: 'conflict_active_run';
  message: string;
  threadId: string;
  activeRunId: string;
}

export interface NotFoundPathError {
  code: 'not_found';
  message: string;
  path: string;
}

export interface InvalidPathError {
  code: 'invalid_path';
  message: string;
  path: string;
}

export interface AlreadyExistsError {
  code: 'already_exists';
  message: string;
  path: string;
}

export type PathApiError =
  | ConflictStaleWriteError
  | NotFoundPathError
  | InvalidPathError
  | AlreadyExistsError;

export type ApiError =
  | GenericApiError
  | ConflictStaleWriteError
  | ConflictActiveRunError
  | NotFoundPathError
  | InvalidPathError
  | AlreadyExistsError;

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export function isGenericApiErrorCode(
  value: unknown,
): value is GenericApiErrorCode {
  return (
    isErrorCode(value) &&
    value !== 'conflict_stale_write' &&
    value !== 'conflict_active_run'
  );
}

export function isApiError(value: unknown): value is ApiError {
  if (
    !isRecord(value) ||
    !isErrorCode(value.code) ||
    !isString(value.message)
  ) {
    return false;
  }
  if (value.code === 'conflict_stale_write') {
    return isConflictStaleWriteError(value);
  }
  if (value.code === 'conflict_active_run') {
    return isConflictActiveRunError(value);
  }
  if (isPathCapableGenericApiErrorCode(value.code) && 'path' in value) {
    return isPathCapableApiError(value);
  }
  return true;
}

function isPathCapableGenericApiErrorCode(
  code: ErrorCode,
): code is
  | NotFoundPathError['code']
  | InvalidPathError['code']
  | AlreadyExistsError['code'] {
  return (
    code === 'not_found' || code === 'invalid_path' || code === 'already_exists'
  );
}

function isPathCapableApiError(
  value: unknown,
): value is NotFoundPathError | InvalidPathError | AlreadyExistsError {
  return (
    isNotFoundPathError(value) ||
    isInvalidPathError(value) ||
    isAlreadyExistsError(value)
  );
}

export function isPersistenceErrorCode(
  value: unknown,
): value is PersistenceErrorCode {
  return (
    typeof value === 'string' &&
    (PERSISTENCE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isPersistenceApiError(
  value: unknown,
): value is ApiError & { code: PersistenceErrorCode } {
  return isApiError(value) && isPersistenceErrorCode(value.code);
}

export function isConflictStaleWriteError(
  value: unknown,
): value is ConflictStaleWriteError {
  return (
    isRecord(value) &&
    value.code === 'conflict_stale_write' &&
    isString(value.message) &&
    isString(value.path) &&
    isString(value.currentVersionToken)
  );
}

export function isConflictActiveRunError(
  value: unknown,
): value is ConflictActiveRunError {
  return (
    isRecord(value) &&
    value.code === 'conflict_active_run' &&
    isString(value.message) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isString(value.activeRunId) &&
    isRunId(value.activeRunId)
  );
}

export function isNotFoundPathError(
  value: unknown,
): value is NotFoundPathError {
  return (
    isRecord(value) &&
    value.code === 'not_found' &&
    isString(value.message) &&
    isString(value.path)
  );
}

export function isInvalidPathError(value: unknown): value is InvalidPathError {
  return (
    isRecord(value) &&
    value.code === 'invalid_path' &&
    isString(value.message) &&
    isString(value.path)
  );
}

export function isAlreadyExistsError(
  value: unknown,
): value is AlreadyExistsError {
  return (
    isRecord(value) &&
    value.code === 'already_exists' &&
    isString(value.message) &&
    isString(value.path)
  );
}
