interface MemoizeCache<TArgs extends readonly unknown[]> {
  clear(): void;
  delete(...args: TArgs): boolean;
  has(...args: TArgs): boolean;
  size(): number;
}

type MemoizedAsyncFunction<TArgs extends readonly unknown[], TValue> = ((
  ...args: TArgs
) => Promise<TValue>) & {
  readonly cache: MemoizeCache<TArgs>;
};

interface MemoizeOptions<TArgs extends readonly unknown[]> {
  ttlMs?: number;
  cacheKey?: (...args: TArgs) => string;
  now?: () => number;
}

interface MemoizedEntry<TValue> {
  promise: Promise<TValue>;
  expiresAt: number | null;
}

export function memoize<TArgs extends readonly unknown[], TValue>(
  fn: (...args: TArgs) => Promise<TValue>,
  options: MemoizeOptions<TArgs> = {},
): MemoizedAsyncFunction<TArgs, TValue> {
  const entries = new Map<string, MemoizedEntry<TValue>>();
  const cacheKey = options.cacheKey ?? createJsonMemoizeCacheKey<TArgs>;
  const now = options.now ?? Date.now;

  function resolveExpiresAt(): number | null {
    return options.ttlMs === undefined ? null : now() + options.ttlMs;
  }

  function isFresh(entry: MemoizedEntry<TValue>): boolean {
    return entry.expiresAt === null || entry.expiresAt > now();
  }

  function deleteArgs(...args: TArgs): boolean {
    return entries.delete(cacheKey(...args));
  }

  const memoized = (async (...args: TArgs): Promise<TValue> => {
    const key = cacheKey(...args);
    const cached = entries.get(key);
    if (cached && isFresh(cached)) {
      return cached.promise;
    }
    if (cached) {
      entries.delete(key);
    }

    const promise = fn(...args);
    entries.set(key, {
      promise,
      expiresAt: resolveExpiresAt(),
    });
    promise.catch(() => {
      if (entries.get(key)?.promise === promise) {
        entries.delete(key);
      }
    });
    return promise;
  }) as MemoizedAsyncFunction<TArgs, TValue>;

  Object.defineProperty(memoized, 'cache', {
    value: Object.freeze({
      clear() {
        entries.clear();
      },
      delete: deleteArgs,
      has(...args: TArgs) {
        const entry = entries.get(cacheKey(...args));
        return entry !== undefined && isFresh(entry);
      },
      size() {
        return entries.size;
      },
    } satisfies MemoizeCache<TArgs>),
  });

  return memoized;
}

function createJsonMemoizeCacheKey<TArgs extends readonly unknown[]>(
  ...args: TArgs
): string {
  return JSON.stringify(args);
}
