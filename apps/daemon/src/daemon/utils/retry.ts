interface RetryDelayOptions {
  attemptIndex: number;
  baseDelayMs: number;
  multiplier?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

interface RetryAsyncOptions<T> {
  run: (attemptIndex: number) => Promise<T>;
  shouldRetry: (error: unknown, attemptIndex: number) => boolean;
  maxRetries: number;
  delayMs: (attemptIndex: number, error: unknown) => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export function calculateRetryDelayMs({
  attemptIndex,
  baseDelayMs,
  multiplier = 2,
  maxDelayMs,
  jitterRatio = 0,
  random = Math.random,
}: RetryDelayOptions): number {
  assertNonNegativeInteger(attemptIndex, 'attemptIndex');
  assertNonNegativeNumber(baseDelayMs, 'baseDelayMs');
  assertPositiveNumber(multiplier, 'multiplier');
  assertNonNegativeNumber(jitterRatio, 'jitterRatio');
  if (maxDelayMs !== undefined) {
    assertNonNegativeNumber(maxDelayMs, 'maxDelayMs');
  }

  const exponentialDelayMs = baseDelayMs * multiplier ** attemptIndex;
  const cappedDelayMs =
    maxDelayMs === undefined
      ? exponentialDelayMs
      : Math.min(exponentialDelayMs, maxDelayMs);

  if (jitterRatio === 0 || cappedDelayMs === 0) {
    return cappedDelayMs;
  }

  const jitterWindowMs = cappedDelayMs * jitterRatio;
  const jitterOffsetMs = (random() * 2 - 1) * jitterWindowMs;
  return Math.max(0, cappedDelayMs + jitterOffsetMs);
}

export async function retryAsync<T>({
  run,
  shouldRetry,
  maxRetries,
  delayMs,
  sleep = sleepFor,
}: RetryAsyncOptions<T>): Promise<T> {
  assertNonNegativeInteger(maxRetries, 'maxRetries');

  let attemptIndex = 0;
  for (;;) {
    try {
      return await run(attemptIndex);
    } catch (error) {
      if (attemptIndex >= maxRetries || !shouldRetry(error, attemptIndex)) {
        throw error;
      }

      const nextDelayMs = delayMs(attemptIndex, error);
      assertNonNegativeNumber(nextDelayMs, 'delayMs');
      if (nextDelayMs > 0) {
        await sleep(nextDelayMs);
      }
      attemptIndex += 1;
    }
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertNonNegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number`);
  }
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
}

function sleepFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
