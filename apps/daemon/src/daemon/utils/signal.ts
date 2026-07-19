import { getErrorMessage } from './error.js';
import { createLogger } from '@geulbat/shared-utils/logger';

export interface Signal<Args extends unknown[]> {
  subscribe(listener: (...args: Args) => void): () => void;
  emit(...args: Args): void;
  clear(): void;
}

const logger = createLogger('signal');
type SignalLifecycleHookName = 'onEmpty' | 'onListenerError';

export function createSignal<Args extends unknown[]>(options?: {
  onListenerError?: (error: unknown) => void;
  onEmpty?: () => void;
}): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>();

  const reportLifecycleHookFailure = (
    hookName: SignalLifecycleHookName,
    hookError: unknown,
  ): void => {
    logger
      .withContext({ hook: hookName })
      .warn('signal lifecycle hook failed:', getErrorMessage(hookError));
  };

  const notifyEmpty = (): void => {
    try {
      options?.onEmpty?.();
    } catch (hookError: unknown) {
      // Signal lifecycle hooks are best-effort and must not break teardown.
      reportLifecycleHookFailure('onEmpty', hookError);
    }
  };

  const notifyListenerError = (error: unknown): void => {
    try {
      options?.onListenerError?.(error);
    } catch (hookError: unknown) {
      // Listener error reporting is isolated from the listener delivery path.
      reportLifecycleHookFailure('onListenerError', hookError);
    }
  };

  const removeListener = (listener: (...args: Args) => void): void => {
    if (!listeners.delete(listener)) {
      return;
    }
    if (listeners.size === 0) {
      notifyEmpty();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      let active = true;

      return () => {
        if (!active) {
          return;
        }
        active = false;
        removeListener(listener);
      };
    },

    emit(...args) {
      const snapshot = [...listeners];
      for (const listener of snapshot) {
        try {
          listener(...args);
        } catch (error: unknown) {
          notifyListenerError(error);
        }
      }
    },

    clear() {
      if (listeners.size === 0) {
        return;
      }
      listeners.clear();
      notifyEmpty();
    },
  };
}
