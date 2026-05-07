import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ApiError,
  isAlreadyExistsError,
  isApiError,
  isConflictActiveRunError,
  isErrorCode,
  isGenericApiErrorCode,
  isInvalidPathError,
  isNotFoundPathError,
} from './errors.js';
import type { PathApiError } from './errors.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'run-active-1';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type _ApiErrorPathVariantsAreExtractable = Expect<
  Equal<Extract<ApiError, { path: string }>, PathApiError>
>;

void test('isErrorCode accepts only canonical protocol error codes', () => {
  assert.equal(isErrorCode('internal'), true);
  assert.equal(isErrorCode('totally_new_error'), false);
});

void test('isApiError rejects unknown error codes even when the shape looks valid', () => {
  assert.equal(isApiError({ code: 'internal', message: 'boom' }), true);
  assert.equal(
    isApiError({ code: 'totally_new_error', message: 'boom' }),
    false,
  );
});

void test('isApiError requires stale-write conflict wire fields', () => {
  const staleWriteError = {
    code: 'conflict_stale_write',
    message: 'stale write',
    path: 'draft/ch1.md',
    currentVersionToken: 'v2',
  } as const;

  assert.equal(isApiError(staleWriteError), true);
  assert.equal(
    isApiError({
      code: 'conflict_stale_write',
      message: 'stale write',
      path: 'draft/ch1.md',
    }),
    false,
  );
  assert.equal(
    isApiError({
      code: 'conflict_stale_write',
      message: 'stale write',
      currentVersionToken: 'v2',
    }),
    false,
  );

  assert.equal(readStaleWritePath(staleWriteError), 'draft/ch1.md');
});

void test('isApiError requires active-run conflict wire fields', () => {
  const activeRunError = {
    code: 'conflict_active_run',
    message: 'thread has an active run',
    threadId: THREAD_ID,
    activeRunId: RUN_ID,
  } as const;

  assert.equal(isGenericApiErrorCode('conflict_active_run'), false);
  assert.equal(isApiError(activeRunError), true);
  assert.equal(isConflictActiveRunError(activeRunError), true);
  assert.equal(
    isApiError({
      code: 'conflict_active_run',
      message: 'thread has an active run',
    }),
    false,
  );
  assert.equal(
    isApiError({
      code: 'conflict_active_run',
      message: 'thread has an active run',
      threadId: 'not-a-thread-id',
      activeRunId: RUN_ID,
    }),
    false,
  );

  assert.equal(readActiveRunId(activeRunError), RUN_ID);
});

function readStaleWritePath(error: ApiError): string | null {
  if (error.code !== 'conflict_stale_write') {
    return null;
  }
  return error.path;
}

function readActiveRunId(error: ApiError): string | null {
  if (error.code !== 'conflict_active_run') {
    return null;
  }
  return error.activeRunId;
}

void test('path error guards accept only matching path payloads', () => {
  assert.equal(
    isNotFoundPathError({
      code: 'not_found',
      message: 'missing',
      path: 'draft/ch1.md',
    }),
    true,
  );
  assert.equal(
    isInvalidPathError({
      code: 'invalid_path',
      message: 'bad path',
      path: 'draft/ch1.md',
    }),
    true,
  );
  assert.equal(
    isAlreadyExistsError({
      code: 'already_exists',
      message: 'exists',
      path: 'draft/ch1.md',
    }),
    true,
  );
  assert.equal(
    isNotFoundPathError({
      code: 'not_found',
      message: 'missing',
    }),
    false,
  );
  assert.equal(
    isInvalidPathError({
      code: 'already_exists',
      message: 'exists',
      path: 'draft/ch1.md',
    }),
    false,
  );
});

void test('isApiError preserves generic path-capable errors without forcing path fields', () => {
  assert.equal(isGenericApiErrorCode('not_found'), true);
  assert.equal(isGenericApiErrorCode('invalid_path'), true);
  assert.equal(isGenericApiErrorCode('already_exists'), true);

  assert.equal(isApiError({ code: 'not_found', message: 'missing' }), true);
  assert.equal(isApiError({ code: 'invalid_path', message: 'bad path' }), true);
  assert.equal(
    isApiError({ code: 'already_exists', message: 'already exists' }),
    true,
  );
});

void test('isApiError rejects malformed path fields on path-capable errors', () => {
  assert.equal(
    isApiError({
      code: 'not_found',
      message: 'missing',
      path: 123,
    }),
    false,
  );
  assert.equal(
    isApiError({
      code: 'invalid_path',
      message: 'bad path',
      path: 123,
    }),
    false,
  );
  assert.equal(
    isApiError({
      code: 'already_exists',
      message: 'already exists',
      path: 123,
    }),
    false,
  );
});
