export function createKeyedSerialRunner() {
  const tails = new Map<string, Promise<void>>();

  return async function runSerializedByKey<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Queue registration must stay synchronous so later callers observe this tail before any await.
    const previous = tails.get(key) ?? Promise.resolve();
    const waitForPreviousTail = () =>
      previous.then(
        () => undefined,
        () => undefined,
      );
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = waitForPreviousTail().then(() => current);
    tails.set(key, queued);

    // Prior failures must not block the next serialized operation for the key.
    await waitForPreviousTail();
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (tails.get(key) === queued) {
        tails.delete(key);
      }
    }
  };
}
