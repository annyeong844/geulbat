/**
 * Protocol error types — serializable JSON shape interfaces.
 * NOT runtime Error classes. These go directly on the wire.
 */

import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import { isPermissionMode, type PermissionMode } from './run-approval.js';
import { isRecord, isString } from './wire-value-guards.js';

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
  // TLS 인증서 검증 실패. 호스트 환경(CA bundle, TLS 검사 프록시, 만료·자가서명
  // 인증서)이 원인이라 재시도해도 같은 handshake 실패가 반복된다. 연결 유실로
  // 묶으면 재시도 예산을 태운 뒤 "timed out"이라는 틀린 진단이 나간다.
  | 'llm_tls_verification_failed'
  | 'llm_rate_limited'
  // 크레딧·구독·쿼터 소진. 일시 rate-limit과 다르다 — 같은 요청을 재시도해도
  // 결정적으로 실패하므로 rate-limit 재시도 예산을 태우지 않는다.
  | 'llm_usage_limit_exceeded'
  | 'llm_auth_failed'
  | 'llm_context_length_exceeded'
  // 요청한 max_tokens(출력 상한)가 모델/남은 창을 넘는 경우. 입력 컨텍스트
  // overflow와 다르다 — 압축해도 같은 max_tokens로 다시 실패하므로 압축
  // 경로로 보내지 않는다.
  | 'llm_output_budget_exceeded'
  // Responses WS encrypted reasoning blob 검증 실패. context overflow와
  // 문구가 겹칠 수 있어 별도 코드로 둔다.
  | 'llm_replay_state_rejected'
  | 'provider_transition_required'
  | 'provider_transition_preparation_failed'
  | 'rate_limited'
  | 'invalid_path'
  | 'already_exists'
  | 'path_out_of_computer_scope'
  | 'access_denied'
  | 'binary_file'
  | 'buffer_limit_exceeded'
  | 'unsupported_mode'
  | 'execution_failed'
  // 완료 obligation 분류(P7c §5.6) — 같은 gap fingerprint와 같은 evidence
  // revision이 configured threshold까지 반복되면 run을 이 코드로 멈춘다.
  // `execution_failed`와 구분해야 무진전과 실제 실행 오류가 같은 표면으로
  // 뭉개지지 않는다.
  | 'run_no_progress'
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

const TOOL_FAILURE_PHASES = [
  'admission',
  'command_start',
  'command_wait',
  'content_scan',
  'filename_scan',
] as const;

export type ToolFailurePhase = (typeof TOOL_FAILURE_PHASES)[number];

export interface ToolFailureDiagnostics {
  phase: ToolFailurePhase;
  reasonCode: string;
  retryHint?: string;
  gate?: {
    kind: 'plan_approval';
    effectivePermissionMode: PermissionMode;
  };
}

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
  'llm_tls_verification_failed',
  'llm_rate_limited',
  'llm_usage_limit_exceeded',
  'llm_auth_failed',
  'llm_context_length_exceeded',
  'llm_output_budget_exceeded',
  'llm_replay_state_rejected',
  'provider_transition_required',
  'provider_transition_preparation_failed',
  'rate_limited',
  'invalid_path',
  'already_exists',
  'path_out_of_computer_scope',
  'access_denied',
  'binary_file',
  'buffer_limit_exceeded',
  'unsupported_mode',
  'execution_failed',
  'run_no_progress',
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

const PERSISTENCE_ERROR_CODES = [
  'persistence_unsupported',
  'persistence_blocked',
  'persistence_unavailable',
  'persistence_conflict',
  'persistence_quota_exceeded',
] as const;

type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export interface ConflictStaleWriteError {
  code: 'conflict_stale_write';
  message: string;
  path: string;
  currentVersionToken: string;
}

export interface ConflictActiveRunError {
  code: 'conflict_active_run';
  message: string;
  threadId: ThreadId;
  activeRunId: RunId;
}

interface NotFoundPathError {
  code: 'not_found';
  message: string;
  path: string;
}

interface InvalidPathError {
  code: 'invalid_path';
  message: string;
  path: string;
}

interface AlreadyExistsError {
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
const TOOL_FAILURE_PHASE_SET: ReadonlySet<string> = new Set(
  TOOL_FAILURE_PHASES,
);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

export function isToolFailureDiagnostics(
  value: unknown,
): value is ToolFailureDiagnostics {
  if (
    !isRecord(value) ||
    !isString(value.phase) ||
    !TOOL_FAILURE_PHASE_SET.has(value.phase) ||
    !isString(value.reasonCode) ||
    value.reasonCode.length === 0 ||
    (value.retryHint !== undefined &&
      (!isString(value.retryHint) || value.retryHint.length === 0))
  ) {
    return false;
  }

  return (
    value.gate === undefined ||
    (isRecord(value.gate) &&
      value.gate.kind === 'plan_approval' &&
      isPermissionMode(value.gate.effectivePermissionMode))
  );
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

function isPersistenceErrorCode(value: unknown): value is PersistenceErrorCode {
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
