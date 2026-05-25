import test from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorCode } from '@geulbat/protocol/errors';

import {
  ERROR_CODES,
  coerceGenericApiErrorCode,
  errorCodeToStatus,
  isGenericApiErrorCode,
} from './error-codes.js';

const CASES = {
  persistence_unsupported: 501,
  persistence_blocked: 403,
  persistence_unavailable: 503,
  persistence_conflict: 409,
  persistence_quota_exceeded: 413,
  provider_auth_already_connected: 409,
  provider_auth_not_configured: 503,
  provider_auth_callback_unavailable: 503,
  provider_auth_session_not_found: 404,
  provider_auth_session_expired: 410,
  provider_auth_exchange_failed: 502,
  provider_auth_exchange_timeout: 504,
  provider_auth_account_id_missing: 502,
  provider_auth_write_failed: 500,
  provider_auth_invalid: 410,
  provider_auth_refresh_failed: 502,
  unknown_tool: 404,
  invalid_args: 400,
  approval_required: 403,
  approval_denied: 403,
  approval_aborted: 403,
  approval_timeout: 504,
  timeout: 504,
  aborted: 409,
  conflict: 409,
  conflict_stale_write: 409,
  conflict_active_run: 409,
  index_not_ready: 503,
  not_implemented: 501,
  bad_request: 400,
  llm_connect_timeout: 504,
  llm_idle_timeout: 504,
  llm_rate_limited: 429,
  rate_limited: 429,
  llm_auth_failed: 502,
  llm_context_length_exceeded: 400,
  invalid_path: 400,
  already_exists: 409,
  path_out_of_workspace: 403,
  access_denied: 403,
  binary_file: 400,
  buffer_limit_exceeded: 400,
  unsupported_mode: 400,
  execution_failed: 500,
  not_found: 404,
  unauthorized: 401,
  internal: 500,
} satisfies Record<ErrorCode, number>;

void test('errorCodeToStatus covers every protocol error code', () => {
  for (const [code, expected] of Object.entries(CASES)) {
    assert.equal(
      errorCodeToStatus(code as ErrorCode),
      expected,
      `unexpected HTTP status for ${code}`,
    );
  }
});

void test('ERROR_CODES matches the protocol error-code set exactly', () => {
  const expectedCodes = Object.keys(CASES).sort();
  const actualCodes = [...ERROR_CODES].sort();
  assert.deepEqual(actualCodes, expectedCodes);
});

void test('generic API error codes exclude stale-write conflicts', () => {
  assert.equal(isGenericApiErrorCode('internal'), true);
  assert.equal(isGenericApiErrorCode('conflict_stale_write'), false);
  assert.equal(
    coerceGenericApiErrorCode('conflict_stale_write', 'internal'),
    'internal',
  );
});
