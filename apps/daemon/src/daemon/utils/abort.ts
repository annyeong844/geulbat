interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export function createMergedAbortSignal(
  ...signals: (AbortSignalLike | undefined)[]
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignalLike; handler: () => void }> = [];

  const cleanup = () => {
    for (const { signal, handler } of listeners) {
      signal.removeEventListener('abort', handler);
    }
    listeners.length = 0;
  };

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      cleanup();
      return { signal: controller.signal, cleanup };
    }

    const handler = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    listeners.push({ signal, handler });
    signal.addEventListener('abort', handler, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

export function mergeAbortSignals(
  ...signals: (AbortSignalLike | undefined)[]
): AbortSignal {
  return createMergedAbortSignal(...signals).signal;
}
