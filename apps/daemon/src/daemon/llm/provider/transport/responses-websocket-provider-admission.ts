interface ProviderAdmissionWaiter {
  resolve: (release: (() => void) | undefined) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

interface ProviderAdmissionState {
  untilMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  probe: symbol | undefined;
  probeRejected: boolean;
  waiters: Set<ProviderAdmissionWaiter>;
}

interface ResponsesWebSocketProviderAdmissionDeps {
  now: () => number;
  scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createResponsesWebSocketProviderAdmission(
  deps: ResponsesWebSocketProviderAdmissionDeps,
) {
  const stateByProviderScope = new Map<string, ProviderAdmissionState>();
  let closed = false;

  function settleWaiter(
    waiter: ProviderAdmissionWaiter,
    release: (() => void) | undefined,
  ): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(release);
  }

  function rejectWaiter(waiter: ProviderAdmissionWaiter, error: Error): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.reject(error);
  }

  function createProbeRelease(
    providerScope: string,
    state: ProviderAdmissionState,
    probe: symbol,
  ): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (
        stateByProviderScope.get(providerScope) !== state ||
        state.probe !== probe
      ) {
        return;
      }

      state.probe = undefined;
      const probeRejected = state.probeRejected;
      state.probeRejected = false;
      if (probeRejected || state.untilMs > deps.now()) {
        scheduleCooldown(providerScope, state);
        return;
      }

      if (state.timer) {
        deps.clearScheduledTimeout(state.timer);
        state.timer = undefined;
      }
      stateByProviderScope.delete(providerScope);
      const waiters = [...state.waiters];
      state.waiters.clear();
      for (const waiter of waiters) {
        settleWaiter(waiter, undefined);
      }
    };
  }

  function admitNextProbe(
    providerScope: string,
    state: ProviderAdmissionState,
  ): void {
    if (
      closed ||
      stateByProviderScope.get(providerScope) !== state ||
      state.probe !== undefined
    ) {
      return;
    }
    const next = state.waiters.values().next();
    if (next.done) {
      return;
    }
    const waiter = next.value;
    state.waiters.delete(waiter);
    const probe = Symbol();
    state.probe = probe;
    state.probeRejected = false;
    settleWaiter(waiter, createProbeRelease(providerScope, state, probe));
  }

  function scheduleCooldown(
    providerScope: string,
    state: ProviderAdmissionState,
  ): void {
    if (closed || stateByProviderScope.get(providerScope) !== state) {
      return;
    }
    if (state.timer) {
      deps.clearScheduledTimeout(state.timer);
      state.timer = undefined;
    }
    const remainingMs = state.untilMs - deps.now();
    if (remainingMs <= 0) {
      admitNextProbe(providerScope, state);
      return;
    }
    state.timer = deps.scheduleTimeout(() => {
      state.timer = undefined;
      if (closed || stateByProviderScope.get(providerScope) !== state) {
        return;
      }
      if (state.untilMs > deps.now()) {
        scheduleCooldown(providerScope, state);
        return;
      }
      admitNextProbe(providerScope, state);
    }, remainingMs);
    state.timer.unref?.();
  }

  return {
    defer(providerScope: string, retryAfterMs: number): void {
      if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0 || closed) {
        return;
      }
      let state = stateByProviderScope.get(providerScope);
      if (state === undefined) {
        state = {
          untilMs: 0,
          timer: undefined,
          probe: undefined,
          probeRejected: false,
          waiters: new Set(),
        };
        stateByProviderScope.set(providerScope, state);
      }
      state.untilMs = Math.max(state.untilMs, deps.now() + retryAfterMs);
      if (state.probe !== undefined) {
        state.probeRejected = true;
      }
      scheduleCooldown(providerScope, state);
    },
    async waitForAdmission(
      providerScope: string,
      signal?: AbortSignal,
      onWaiting?: () => void,
    ): Promise<(() => void) | undefined> {
      if (closed) {
        throw new Error('responses websocket session store is closed');
      }
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('provider cooldown wait aborted');
      }
      const state = stateByProviderScope.get(providerScope);
      if (state === undefined) {
        return undefined;
      }
      if (state.untilMs <= deps.now() && state.probe === undefined) {
        const probe = Symbol();
        state.probe = probe;
        state.probeRejected = false;
        return createProbeRelease(providerScope, state, probe);
      }

      onWaiting?.();
      return await new Promise<(() => void) | undefined>((resolve, reject) => {
        const waiter: ProviderAdmissionWaiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            if (!state.waiters.delete(waiter)) {
              return;
            }
            rejectWaiter(
              waiter,
              signal?.reason instanceof Error
                ? signal.reason
                : new Error('provider cooldown wait aborted'),
            );
          },
        };
        state.waiters.add(waiter);
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        if (signal?.aborted) {
          waiter.onAbort();
          return;
        }
        if (state.timer === undefined && state.untilMs > deps.now()) {
          scheduleCooldown(providerScope, state);
        }
      });
    },
    readPressureSnapshot() {
      const nowMs = deps.now();
      const scopes = [...stateByProviderScope.entries()]
        .map(([providerScope, state]) => ({
          providerScope,
          cooldownRemainingMs: Math.max(0, state.untilMs - nowMs),
          cooldownWaiterCount: state.waiters.size,
          cooldownProbeActive: state.probe !== undefined,
        }))
        .sort((left, right) =>
          left.providerScope.localeCompare(right.providerScope),
        );
      return {
        cooldownWaiterCount: scopes.reduce(
          (total, scope) => total + scope.cooldownWaiterCount,
          0,
        ),
        cooldownProbeCount: scopes.filter((scope) => scope.cooldownProbeActive)
          .length,
        scopes,
      };
    },
    close(error: Error): void {
      closed = true;
      for (const state of stateByProviderScope.values()) {
        if (state.timer) {
          deps.clearScheduledTimeout(state.timer);
          state.timer = undefined;
        }
        const waiters = [...state.waiters];
        state.waiters.clear();
        for (const waiter of waiters) {
          rejectWaiter(waiter, error);
        }
      }
      stateByProviderScope.clear();
    },
  };
}
