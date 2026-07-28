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
  results: BackgroundChildResultInput[];
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

function projectVolatileBackgroundResult(
  result: BackgroundChildResultInput,
): BackgroundChildResult {
  const projected = { ...result };
  delete projected.resultReportSummary;
  return projected;
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
  const retryScheduledThreads = new Set<ThreadId>();
  const listenersByThread = new Map<
    ThreadId,
    Signal<[BackgroundChildResult]>
  >();
  let durableStore: SubagentTerminalDeliveryStore | undefined;

  function hasPendingDeliveryId(
    queue: readonly BackgroundChildResultInput[],
    deliveryId: string,
  ): boolean {
    return queue.some((result) => result.deliveryId === deliveryId);
  }

  function retainVolatileBackgroundResult(
    key: ThreadId,
    result: BackgroundChildResultInput,
  ): boolean {
    const pending = pendingByThread.get(key);
    if (pending) {
      if (hasPendingDeliveryId(pending.results, result.deliveryId)) {
        return false;
      }
      pending.results.push(result);
      return true;
    }
    pendingByThread.set(key, { results: [result] });
    return true;
  }

  function retryVolatileBackgroundResults(key: ThreadId): void {
    if (durableStore === undefined) {
      return;
    }
    const pending = pendingByThread.get(key);
    if (pending === undefined || pending.results.length === 0) {
      return;
    }
    const remaining: BackgroundChildResultInput[] = [];
    for (const result of pending.results) {
      try {
        durableStore.recordSubagentTerminalDelivery({
          ownerThreadId: key,
          result,
        });
      } catch (error: unknown) {
        remaining.push(result);
        logger.error('durable background result retry failed:', {
          threadId: key,
          childRunId: result.childRunId,
          deliveryId: result.deliveryId,
          cause: error,
        });
      }
    }
    if (remaining.length === 0) {
      pendingByThread.delete(key);
      return;
    }
    pending.results = remaining;
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
        let recorded: ReturnType<
          SubagentTerminalDeliveryStore['recordSubagentTerminalDelivery']
        >;
        try {
          recorded = durableStore.recordSubagentTerminalDelivery({
            ownerThreadId: key,
            result,
          });
        } catch (error: unknown) {
          const retained = retainVolatileBackgroundResult(key, result);
          if (retained) {
            listenersByThread
              .get(key)
              ?.emit(projectVolatileBackgroundResult(result));
          }
          if (!retryScheduledThreads.has(key)) {
            retryScheduledThreads.add(key);
            queueMicrotask(() => {
              retryScheduledThreads.delete(key);
              retryVolatileBackgroundResults(key);
            });
          }
          logger.error(
            'durable background result enqueue failed; retained volatile delivery:',
            {
              threadId: key,
              childRunId: result.childRunId,
              deliveryId: result.deliveryId,
              cause: error,
            },
          );
          throw error;
        }
        const pending = pendingByThread.get(key);
        if (pending !== undefined) {
          pending.results = pending.results.filter(
            (candidate) => candidate.deliveryId !== result.deliveryId,
          );
          if (pending.results.length === 0) {
            pendingByThread.delete(key);
          }
        }
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
      if (!retainVolatileBackgroundResult(key, result)) {
        return;
      }

      const signal = listenersByThread.get(key);
      if (!signal) {
        return;
      }
      signal.emit(projectVolatileBackgroundResult(result));
    },
    consumeThreadBackgroundResults(threadId) {
      if (durableStore !== undefined) {
        retryVolatileBackgroundResults(threadId);
        const durableResults = durableStore
          .readPendingSubagentTerminalDeliveries(threadId)
          .map(projectDurableOutcome);
        const durableDeliveryIds = new Set(
          durableResults.map((result) => result.deliveryId),
        );
        const volatileResults = (pendingByThread.get(threadId)?.results ?? [])
          .filter((result) => !durableDeliveryIds.has(result.deliveryId))
          .map(projectVolatileBackgroundResult);
        const results = [...durableResults, ...volatileResults];
        durableStore.acknowledgeSubagentTerminalDeliveries({
          ownerThreadId: threadId,
          deliveryIds: results.map((result) => result.deliveryId),
        });
        pendingByThread.delete(threadId);
        return results;
      }
      const key = threadId;
      const pending = pendingByThread.get(key);
      if (!pending || pending.results.length === 0) {
        return [];
      }
      pendingByThread.delete(key);
      return pending.results.map(projectVolatileBackgroundResult);
    },
    readThreadBackgroundResults(threadId) {
      if (durableStore !== undefined) {
        retryVolatileBackgroundResults(threadId);
        const durableResults = durableStore
          .readPendingSubagentTerminalDeliveries(threadId)
          .map(projectDurableOutcome);
        const durableDeliveryIds = new Set(
          durableResults.map((result) => result.deliveryId),
        );
        return [
          ...durableResults,
          ...(pendingByThread.get(threadId)?.results ?? [])
            .filter((result) => !durableDeliveryIds.has(result.deliveryId))
            .map(projectVolatileBackgroundResult),
        ];
      }
      return (
        pendingByThread
          .get(threadId)
          ?.results.map(projectVolatileBackgroundResult) ?? []
      );
    },
    readThreadBackgroundResultHistory(threadId) {
      if (durableStore !== undefined) {
        retryVolatileBackgroundResults(threadId);
        const durableResults = durableStore
          .readSubagentTerminalDeliveries(threadId)
          .map(projectDurableOutcome);
        const durableDeliveryIds = new Set(
          durableResults.map((result) => result.deliveryId),
        );
        return [
          ...durableResults,
          ...(pendingByThread.get(threadId)?.results ?? [])
            .filter((result) => !durableDeliveryIds.has(result.deliveryId))
            .map(projectVolatileBackgroundResult),
        ];
      }
      return (
        pendingByThread
          .get(threadId)
          ?.results.map(projectVolatileBackgroundResult) ?? []
      );
    },
    acknowledgeThreadBackgroundResults(threadId, deliveryIds) {
      if (deliveryIds.length === 0) {
        return;
      }
      if (durableStore !== undefined) {
        retryVolatileBackgroundResults(threadId);
        durableStore.acknowledgeSubagentTerminalDeliveries({
          ownerThreadId: threadId,
          deliveryIds,
        });
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
      retryVolatileBackgroundResults(key);
      const pendingSnapshot =
        durableStore === undefined
          ? (pendingByThread
              .get(key)
              ?.results.map(projectVolatileBackgroundResult) ?? [])
          : (() => {
              const durableResults = durableStore
                .readPendingSubagentTerminalDeliveries(key)
                .map(projectDurableOutcome);
              const durableDeliveryIds = new Set(
                durableResults.map((result) => result.deliveryId),
              );
              return [
                ...durableResults,
                ...(pendingByThread.get(key)?.results ?? [])
                  .filter(
                    (result) => !durableDeliveryIds.has(result.deliveryId),
                  )
                  .map(projectVolatileBackgroundResult),
              ];
            })();
      for (const result of pendingSnapshot) {
        deliverOnce(result);
      }
      return unsubscribe;
    },
  };
}
