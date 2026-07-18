/**
 * Protocol ids use string-literal brands so DTOs stay plain strings at runtime
 * while TypeScript rejects accidental RunId/ThreadId mixing. Keep the
 * regexes private; cross-package callers prevalidate with is* guards and brand
 * at trust boundaries with assert* functions.
 */
type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RunId = Brand<string, 'RunId'>;
export type ThreadId = Brand<string, 'ThreadId'>;

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidRunIdError extends Error {
  readonly code = 'invalid_run_id';

  constructor(runId: string) {
    super(`invalid runId: ${runId}`);
    this.name = 'InvalidRunIdError';
  }
}

export class InvalidThreadIdError extends Error {
  readonly code = 'invalid_thread_id';

  constructor(threadId: string) {
    super(`invalid threadId: ${threadId}`);
    this.name = 'InvalidThreadIdError';
  }
}

export function isRunId(runId: string): runId is RunId {
  return RUN_ID_PATTERN.test(runId);
}

export function isThreadId(threadId: string): threadId is ThreadId {
  return THREAD_ID_PATTERN.test(threadId);
}

export function assertRunId(runId: string): RunId {
  if (!isRunId(runId)) {
    throw new InvalidRunIdError(runId);
  }
  return runId;
}

export function assertThreadId(threadId: string): ThreadId {
  if (!isThreadId(threadId)) {
    throw new InvalidThreadIdError(threadId);
  }
  return threadId;
}
