import type { ThreadId } from '../contract.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { createSignal, type Signal } from '../../utils/signal.js';
import type {
  BackgroundChildResult,
  BackgroundChildResultInput,
  DurableSubagentTerminalOutcome,
  SubagentTerminalDeliveryStore,
} from '../../subagent-runtime-contracts.js';

const logger = createLogger('background-notification');

interface PendingBackgroundResults {
  results: BackgroundChildResult[];
}

function projectDurableOutcome(
  outcome: DurableSubagentTerminalOutcome,
): BackgroundChildResult {
  return {
    ...outcome.result,
    resultRef: outcome.resultRef,
    resultDigest: outcome.resultDigest,
  };
}

export interface BackgroundNotificationQueue {
  attachDurableStore(store: SubagentTerminalDeliveryStore): void;
  enqueueThreadBackgroundResult(
    threadId: ThreadId,
    result: BackgroundChildResultInput,
  ): void;
  consumeThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
  readThreadBackgroundResults(threadId: ThreadId): BackgroundChildResult[];
  readThreadBackgroundResultHistory(
    threadId: ThreadId,
  ): BackgroundChildResult[];
  acknowledgeThreadBackgroundResults(
    threadId: ThreadId,
    deliveryIds: readonly string[],
  ): void;
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
  let durableStore: SubagentTerminalDeliveryStore | undefined;

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

    const signal: Signal<[BackgroundChildResult]> = createSignal<
      [BackgroundChildResult]
    >({
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
    attachDurableStore(store) {
      if (durableStore !== undefined) {
        if (durableStore !== store) {
          throw new Error(
            'background notification queue already has a durable store',
          );
        }
        return;
      }
      for (const [ownerThreadId, pending] of pendingByThread) {
        for (const result of pending.results) {
          store.recordSubagentTerminalDelivery({ ownerThreadId, result });
        }
      }
      durableStore = store;
      pendingByThread.clear();
    },
    enqueueThreadBackgroundResult(threadId, result) {
      const key = threadId;
      if (durableStore !== undefined) {
        const recorded = durableStore.recordSubagentTerminalDelivery({
          ownerThreadId: key,
          result,
        });
        if (!recorded.inserted) {
          return;
        }
        listenersByThread
          .get(key)
          ?.emit(projectDurableOutcome(recorded.outcome));
        return;
      }
      if (result.resultReportSummary !== undefined) {
        throw new Error(
          'durable subagent result storage is required for result reports',
        );
      }
      const inMemoryResult: BackgroundChildResult = result;
      const pending = pendingByThread.get(key);
      if (pending) {
        if (hasPendingDeliveryId(pending.results, inMemoryResult.deliveryId)) {
          return;
        }
        pending.results.push(inMemoryResult);
      } else {
        pendingByThread.set(key, {
          results: [inMemoryResult],
        });
      }

      const signal = listenersByThread.get(key);
      if (!signal) {
        return;
      }
      signal.emit(inMemoryResult);
    },
    consumeThreadBackgroundResults(threadId) {
      if (durableStore !== undefined) {
        const results = durableStore
          .readPendingSubagentTerminalDeliveries(threadId)
          .map(projectDurableOutcome);
        durableStore.acknowledgeSubagentTerminalDeliveries({
          ownerThreadId: threadId,
          deliveryIds: results.map((result) => result.deliveryId),
        });
        return results;
      }
      const key = threadId;
      const pending = pendingByThread.get(key);
      if (!pending || pending.results.length === 0) {
        return [];
      }
      pendingByThread.delete(key);
      return pending.results.slice();
    },
    readThreadBackgroundResults(threadId) {
      if (durableStore !== undefined) {
        return durableStore
          .readPendingSubagentTerminalDeliveries(threadId)
          .map(projectDurableOutcome);
      }
      return pendingByThread.get(threadId)?.results.slice() ?? [];
    },
    readThreadBackgroundResultHistory(threadId) {
      if (durableStore !== undefined) {
        return durableStore
          .readSubagentTerminalDeliveries(threadId)
          .map(projectDurableOutcome);
      }
      return pendingByThread.get(threadId)?.results.slice() ?? [];
    },
    acknowledgeThreadBackgroundResults(threadId, deliveryIds) {
      if (deliveryIds.length === 0) {
        return;
      }
      if (durableStore !== undefined) {
        durableStore.acknowledgeSubagentTerminalDeliveries({
          ownerThreadId: threadId,
          deliveryIds,
        });
        return;
      }
      const pending = pendingByThread.get(threadId);
      if (!pending) {
        return;
      }
      const acknowledged = new Set(deliveryIds);
      const remaining = pending.results.filter(
        (result) => !acknowledged.has(result.deliveryId),
      );
      if (remaining.length === 0) {
        pendingByThread.delete(threadId);
        return;
      }
      pending.results = remaining;
    },
    clearThreadBackgroundResults(threadId) {
      pendingByThread.delete(threadId);
      durableStore?.clearSubagentTerminalDeliveries(threadId);
    },
    subscribeThreadBackgroundResults(threadId, listener) {
      const key = threadId;
      const delivered = new Set<string>();
      const deliverOnce = (result: BackgroundChildResult) => {
        if (delivered.has(result.deliveryId)) {
          return;
        }
        delivered.add(result.deliveryId);
        listener(result);
      };
      const unsubscribe = getOrCreateThreadSignal(key).subscribe(deliverOnce);
      const pendingSnapshot =
        durableStore === undefined
          ? (pendingByThread.get(key)?.results.slice() ?? [])
          : durableStore
              .readPendingSubagentTerminalDeliveries(key)
              .map(projectDurableOutcome);
      for (const result of pendingSnapshot) {
        deliverOnce(result);
      }
      return unsubscribe;
    },
  };
}
