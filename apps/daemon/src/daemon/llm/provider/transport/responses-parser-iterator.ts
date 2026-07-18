export async function nextResponseEvent(
  iterator: AsyncIterator<Record<string, unknown>, unknown>,
  options?: { signal?: AbortSignal; idleTimeoutMs?: number },
): Promise<IteratorResult<Record<string, unknown>, unknown>> {
  if (options?.signal?.aborted) {
    await closeIteratorSilently(iterator);
    throw new Error('Request was aborted');
  }

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let closingIterator: Promise<void> | null = null;

  const closeIteratorOnce = async () => {
    if (closingIterator) {
      return closingIterator;
    }
    closingIterator = closeIteratorSilently(iterator);
    await closingIterator;
  };

  try {
    const nextPromise = iterator.next();
    const races: Array<
      Promise<IteratorResult<Record<string, unknown>, unknown>>
    > = [nextPromise];

    if (options?.idleTimeoutMs && options.idleTimeoutMs > 0) {
      races.push(
        new Promise<IteratorResult<Record<string, unknown>, unknown>>(
          (_, reject) => {
            idleTimer = setTimeout(() => {
              reject(
                Object.assign(new Error('LLM idle timeout'), {
                  llmCode: 'llm_idle_timeout',
                }),
              );
              void closeIteratorOnce();
            }, options.idleTimeoutMs);
          },
        ),
      );
    }

    if (options?.signal) {
      races.push(
        new Promise<IteratorResult<Record<string, unknown>, unknown>>(
          (_, reject) => {
            abortHandler = () => {
              reject(new Error('Request was aborted'));
              void closeIteratorOnce();
            };
            options.signal!.addEventListener('abort', abortHandler!, {
              once: true,
            });
          },
        ),
      );
    }

    return await Promise.race(races);
  } finally {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    if (abortHandler && options?.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}

async function closeIteratorSilently(
  iterator: AsyncIterator<Record<string, unknown>, unknown>,
): Promise<void> {
  if (typeof iterator.return !== 'function') {
    return;
  }
  try {
    await iterator.return();
  } catch {
    // Ignore cancellation cleanup failures and surface the original timeout/abort.
  }
}
