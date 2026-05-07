import type { ThreadId } from '@geulbat/protocol/ids';
import { createLogger } from '@geulbat/shared-utils/logger';
import { createSignal, type Signal } from '../../utils/signal.js';
import type { BackgroundChildResult } from '../../subagent-runtime-contracts.js';

const MAX_PENDING_RESULTS_PER_THREAD = 20;
export const MAX_PENDING_BACKGROUND_THREADS = 128;
const logger = createLogger('background-notification');

interface PendingBackgroundResults {
  results: BackgroundChildResult[];
  updatedAt: number;
}

export interface BackgroundNotificationQueue {
  enqueueThreadBackgroundResult(
    threadId: ThreadId,
    result: BackgroundChildResult,
  ): void;
  consumeThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
  resetThreadBackgroundResultsForTests(threadId: ThreadId): void;
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

  function trimPendingQueue(
    threadId: ThreadId,
    queue: BackgroundChildResult[],
  ): void {
    if (queue.length <= MAX_PENDING_RESULTS_PER_THREAD) {
      return;
    }
    const dropped = queue.splice(
      0,
      queue.length - MAX_PENDING_RESULTS_PER_THREAD,
    );
    logger.warn(
      'dropped oldest pending background results to enforce per-thread cap',
      {
        threadId,
        droppedCount: dropped.length,
        maxPendingResultsPerThread: MAX_PENDING_RESULTS_PER_THREAD,
      },
    );
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

  function prunePendingThreads(protectedKey: ThreadId | undefined): void {
    if (pendingByThread.size <= MAX_PENDING_BACKGROUND_THREADS) {
      return;
    }

    const candidates = [...pendingByThread.entries()]
      .filter(([key]) => key !== protectedKey)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt);

    while (
      pendingByThread.size > MAX_PENDING_BACKGROUND_THREADS &&
      candidates.length > 0
    ) {
      const entry = candidates.shift();
      if (!entry) {
        break;
      }
      logger.warn(
        'evicted pending background thread to enforce global thread cap',
        {
          threadId: entry[0],
          droppedCount: entry[1].results.length,
          maxPendingBackgroundThreads: MAX_PENDING_BACKGROUND_THREADS,
        },
      );
      pendingByThread.delete(entry[0]);
    }
  }

  return {
    enqueueThreadBackgroundResult(threadId, result) {
      const key = threadId;
      const now = Date.now();
      const pending = pendingByThread.get(key);
      if (pending) {
        pending.results.push(result);
        pending.updatedAt = now;
        trimPendingQueue(key, pending.results);
      } else {
        pendingByThread.set(key, {
          results: [result],
          updatedAt: now,
        });
      }
      prunePendingThreads(key);

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
    resetThreadBackgroundResultsForTests(threadId) {
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
