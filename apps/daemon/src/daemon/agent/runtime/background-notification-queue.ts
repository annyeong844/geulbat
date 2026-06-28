import type { ThreadId } from '../contract.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { createSignal, type Signal } from '../../utils/signal.js';
import type { BackgroundChildResult } from '../../subagent-runtime-contracts.js';

const logger = createLogger('background-notification');

interface PendingBackgroundResults {
  results: BackgroundChildResult[];
}

export interface BackgroundNotificationQueue {
  enqueueThreadBackgroundResult(
    threadId: ThreadId,
    result: BackgroundChildResult,
  ): void;
  consumeThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
  clearThreadBackgroundResults(threadId: ThreadId): void;
  subscribeThreadBackgroundResults(
    threadId: ThreadId,
    listener: (result: BackgroundChildResult) => void,
  ): () => void;
}

export function createThreadBackgroundNotificationQueue(): BackgroundNotificationQueue {
  const pendingByThread = new Map<ThreadId, PendingBackgroundResults>();
  const listenersByThread = new Map<
    ThreadId,
    Signal<[BackgroundChildResult]>
  >();

  function hasPendingDeliveryId(
    queue: BackgroundChildResult[],
    deliveryId: string,
  ): boolean {
    return queue.some((result) => result.deliveryId === deliveryId);
  }

  function getOrCreateThreadSignal(
    key: ThreadId,
  ): Signal<[BackgroundChildResult]> {
    const existing = listenersByThread.get(key);
    if (existing) {
      return existing;
    }

    let signal!: Signal<[BackgroundChildResult]>;
    signal = createSignal<[BackgroundChildResult]>({
      onListenerError(error) {
        logger.warn('listener failed:', error);
      },
      onEmpty() {
        if (listenersByThread.get(key) === signal) {
          listenersByThread.delete(key);
        }
      },
    });
    listenersByThread.set(key, signal);
    return signal;
  }

  return {
    enqueueThreadBackgroundResult(threadId, result) {
      const key = threadId;
      const pending = pendingByThread.get(key);
      if (pending) {
        if (hasPendingDeliveryId(pending.results, result.deliveryId)) {
          return;
        }
        pending.results.push(result);
      } else {
        pendingByThread.set(key, {
          results: [result],
        });
      }

      const signal = listenersByThread.get(key);
      if (!signal) {
        return;
      }
      signal.emit(result);
    },
    consumeThreadBackgroundResults(threadId) {
      const key = threadId;
      const pending = pendingByThread.get(key);
      if (!pending || pending.results.length === 0) {
        return [];
      }
      pendingByThread.delete(key);
      return pending.results.slice();
    },
    clearThreadBackgroundResults(threadId) {
      pendingByThread.delete(threadId);
    },
    subscribeThreadBackgroundResults(threadId, listener) {
      const key = threadId;
      const pendingSnapshot = pendingByThread.get(key)?.results.slice() ?? [];
      const unsubscribe = getOrCreateThreadSignal(key).subscribe(listener);
      for (const result of pendingSnapshot) {
        listener(result);
      }
      return unsubscribe;
    },
  };
}
