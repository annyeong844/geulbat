import { randomUUID } from 'node:crypto';

import { runDetached } from '../../../utils/run-detached.js';
import type {
  MaybePromise,
  PtcExecuteCodeCellPlacementRequest,
  PtcExecuteCodePlacementAcquireFailure,
  PtcExecuteCodePlacementRequest,
  PtcExecuteCodeQueuedPlacementAcquisition,
  PtcExecuteCodeSettledPlacementAcquireResult,
} from './execute-code-placement-contract.js';

interface PendingPlacementAcquire {
  queueId: `ptc_placement_queue_${string}`;
  lane: 'warm_session' | 'cold_burst';
  request: PtcExecuteCodePlacementRequest;
  sequence: number;
  resolve(result: PtcExecuteCodeSettledPlacementAcquireResult): void;
  abortListener?: () => void;
}

export function createPtcExecuteCodePlacementQueue(deps: {
  canAcquireWarmPlacement: () => boolean;
  canAcquireBurstPlacement: () => boolean;
  acquireWarmPlacement: (
    request: PtcExecuteCodePlacementRequest,
  ) => MaybePromise<PtcExecuteCodeSettledPlacementAcquireResult>;
  prepareBurstPlacement: (
    request: PtcExecuteCodePlacementRequest,
  ) => (() => PtcExecuteCodeSettledPlacementAcquireResult) | undefined;
  cancelledAcquireFailure: (
    request: PtcExecuteCodePlacementRequest,
  ) => PtcExecuteCodePlacementAcquireFailure;
  shutdownAcquireFailure: (
    request: PtcExecuteCodePlacementRequest,
  ) => PtcExecuteCodePlacementAcquireFailure;
}) {
  const pendingWarmQueue: PendingPlacementAcquire[] = [];
  const pendingBurstByThread = new Map<string, PendingPlacementAcquire[]>();
  const burstFairnessOrder: string[] = [];
  let queueSequence = 0;
  let burstFairnessCursor = 0;

  function enqueuePlacement(
    request: PtcExecuteCodeCellPlacementRequest,
    lane: PendingPlacementAcquire['lane'],
    queueReason?:
      | 'resource_budget_unavailable'
      | 'resource_budget_insufficient',
  ): PtcExecuteCodeQueuedPlacementAcquisition {
    queueSequence += 1;
    const queueId = `ptc_placement_queue_${randomUUID()}` as const;
    let resolvePlacement:
      | ((result: PtcExecuteCodeSettledPlacementAcquireResult) => void)
      | undefined;
    const waitForPlacement =
      new Promise<PtcExecuteCodeSettledPlacementAcquireResult>((resolve) => {
        resolvePlacement = resolve;
      });
    if (resolvePlacement === undefined) {
      throw new Error('PTC placement queue resolver is unavailable');
    }
    const pending: PendingPlacementAcquire = {
      queueId,
      lane,
      request,
      sequence: queueSequence,
      resolve: resolvePlacement,
    };
    if (lane === 'warm_session') {
      pendingWarmQueue.push(pending);
    } else {
      const threadQueue =
        pendingBurstByThread.get(request.identity.threadId) ?? [];
      threadQueue.push(pending);
      pendingBurstByThread.set(request.identity.threadId, threadQueue);
    }
    if (
      lane === 'cold_burst' &&
      !burstFairnessOrder.includes(request.identity.threadId)
    ) {
      burstFairnessOrder.push(request.identity.threadId);
    }
    attachPendingAbort(pending);
    if (lane === 'warm_session') {
      drainWarmQueue();
    } else {
      drainBurstQueue();
    }
    return {
      ok: true,
      queued: true,
      queueId,
      cancel: () => {
        cancelPendingAcquire(pending);
      },
      waitForPlacement,
      diagnostics: {
        queueLane: lane,
        queueSequence: pending.sequence,
        ownerThreadId: request.identity.threadId,
        ...(queueReason === undefined ? {} : { queueReason }),
      },
    };
  }

  function attachPendingAbort(pending: PendingPlacementAcquire): void {
    const signal = pending.request.signal;
    if (signal === undefined) {
      return;
    }
    const onAbort = () => {
      cancelPendingAcquire(pending);
    };
    pending.abortListener = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  }

  function cancelPendingAcquire(pending: PendingPlacementAcquire): void {
    if (!removePendingAcquire(pending)) {
      return;
    }
    settlePendingAcquire(
      pending,
      deps.cancelledAcquireFailure(pending.request),
    );
  }

  function drainWarmQueue(): void {
    if (!deps.canAcquireWarmPlacement()) {
      return;
    }
    const pending = pendingWarmQueue.shift();
    if (pending === undefined) {
      return;
    }
    runDetached('ptc/warm-placement-acquire', () =>
      Promise.resolve(deps.acquireWarmPlacement(pending.request)).then(
        (result) => {
          settlePendingAcquire(pending, result);
        },
      ),
    );
  }

  function drainBurstQueue(): void {
    if (!deps.canAcquireBurstPlacement()) {
      return;
    }
    while (burstFairnessOrder.length > 0) {
      const selected = selectNextBurstQueueThread();
      if (selected === undefined) {
        return;
      }
      const pending = pendingBurstByThread.get(selected)?.[0];
      if (pending === undefined) {
        removeBurstFairnessThread(selected);
        continue;
      }
      const acquire = deps.prepareBurstPlacement(pending.request);
      if (acquire === undefined) {
        return;
      }
      const shifted = shiftPendingAcquire(selected);
      if (shifted === undefined) {
        continue;
      }
      settlePendingAcquire(shifted, acquire());
    }
  }

  function selectNextBurstQueueThread(): string | undefined {
    if (burstFairnessOrder.length === 0) {
      return undefined;
    }
    const candidateCount = burstFairnessOrder.length;
    for (let offset = 0; offset < candidateCount; offset += 1) {
      const index = (burstFairnessCursor + offset) % candidateCount;
      const threadId = burstFairnessOrder[index];
      if (threadId === undefined) {
        continue;
      }
      const queue = pendingBurstByThread.get(threadId);
      if (queue === undefined || queue.length === 0) {
        removeBurstFairnessThread(threadId);
        return selectNextBurstQueueThread();
      }
      burstFairnessCursor = (index + 1) % burstFairnessOrder.length;
      return threadId;
    }
    return undefined;
  }

  function settlePendingAcquire(
    pending: PendingPlacementAcquire,
    result: PtcExecuteCodeSettledPlacementAcquireResult,
  ): void {
    if (pending.abortListener !== undefined) {
      pending.request.signal?.removeEventListener(
        'abort',
        pending.abortListener,
      );
      delete pending.abortListener;
    }
    pending.resolve(result);
  }

  function removePendingAcquire(pending: PendingPlacementAcquire): boolean {
    const queue =
      pending.lane === 'warm_session'
        ? pendingWarmQueue
        : pendingBurstByThread.get(pending.request.identity.threadId);
    if (queue === undefined) {
      return false;
    }
    const index = queue.indexOf(pending);
    if (index < 0) {
      return false;
    }
    queue.splice(index, 1);
    if (pending.lane === 'cold_burst' && queue.length === 0) {
      pendingBurstByThread.delete(pending.request.identity.threadId);
      removeBurstFairnessThread(pending.request.identity.threadId);
    }
    return true;
  }

  function removeBurstFairnessThread(threadId: string): void {
    const index = burstFairnessOrder.indexOf(threadId);
    if (index < 0) {
      return;
    }
    burstFairnessOrder.splice(index, 1);
    if (burstFairnessOrder.length === 0) {
      burstFairnessCursor = 0;
      return;
    }
    if (index < burstFairnessCursor) {
      burstFairnessCursor -= 1;
    }
    burstFairnessCursor %= burstFairnessOrder.length;
  }

  function shiftPendingAcquire(
    threadId: string,
  ): PendingPlacementAcquire | undefined {
    const queue = pendingBurstByThread.get(threadId);
    const pending = queue?.shift();
    if (queue !== undefined && queue.length === 0) {
      pendingBurstByThread.delete(threadId);
    }
    return pending;
  }

  function rejectPendingAcquires(): void {
    const pending = [
      ...pendingWarmQueue,
      ...[...pendingBurstByThread.values()].flat(),
    ];
    pendingWarmQueue.length = 0;
    pendingBurstByThread.clear();
    burstFairnessOrder.length = 0;
    burstFairnessCursor = 0;
    for (const entry of pending) {
      settlePendingAcquire(entry, deps.shutdownAcquireFailure(entry.request));
    }
  }

  return {
    enqueuePlacement,
    drainWarmQueue,
    drainBurstQueue,
    rejectPendingAcquires,
    readPressureSnapshot() {
      return {
        queuedWarmPlacementCount: pendingWarmQueue.length,
        queuedBurstPlacementCount: [...pendingBurstByThread.values()].reduce(
          (count, queue) => count + queue.length,
          0,
        ),
        queuedBurstThreadCount: pendingBurstByThread.size,
      };
    },
  };
}
