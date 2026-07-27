import { randomUUID } from 'node:crypto';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { RunId } from './contract.js';
import type { ToolRunState } from '../runtime-contracts.js';
import { countActiveBackgroundChildren } from './runtime/run-state.js';
import type {
  DurableSubagentLaunchRequest,
  SubagentLaunchDeferReason,
  SubagentLaunchRequestStore,
  SubagentLaunchReservation,
} from '../subagent-runtime-contracts.js';
import { getErrorMessage } from '../utils/error.js';
import { runDetached } from '../utils/run-detached.js';

export const SUBAGENT_BACKGROUND_CAPACITY_ENV =
  'GEULBAT_SUBAGENT_BACKGROUND_CAPACITY';

type SubagentConcurrencyEnv = Readonly<
  Partial<Record<typeof SUBAGENT_BACKGROUND_CAPACITY_ENV, string | undefined>>
>;

const UNSIGNED_BASE_10_INTEGER_PATTERN = /^\d+$/u;
const DEFAULT_ULTRA_SUBAGENT_TREE_CONCURRENCY = 3;
const logger = createLogger('agent/subagent-concurrency');

export interface SubagentConcurrencyPolicy {
  maxConcurrentChildren?: number | null;
}

interface SubagentTreeCapacityState {
  activeLeaseIds: Set<string>;
  maxConcurrentChildren: number | null;
  transferableLeaseIds: Set<string>;
}

type SubagentLaunchAdmission =
  | {
      ok: true;
      reservation: SubagentLaunchReservation;
    }
  | {
      ok: false;
      errorCode: 'too_many_child_runs';
      error: string;
      effectiveMax: number;
    };

export interface SubagentAdmissionController {
  reserveSubagentLaunchSlots(args: {
    runState: ToolRunState;
    requestedChildren: number;
    ultraReasoning?: boolean;
    transferable?: boolean;
    transferExistingReservation?: boolean;
  }): SubagentLaunchAdmission;
  subscribeToCapacityChanges?(listener: () => void): () => void;
}

interface DeferredSubagentLaunchRegistration {
  childRunId: RunId;
  ultraReasoning: boolean;
  parentRunState: ToolRunState;
  start(): Promise<void>;
}

export interface SubagentLaunchPromotionController {
  deferLaunch(args: {
    registration: DeferredSubagentLaunchRegistration;
    deferReason: SubagentLaunchDeferReason;
  }): DurableSubagentLaunchRequest;
  restoreQueuedLaunch(
    registration: DeferredSubagentLaunchRegistration,
  ): DurableSubagentLaunchRequest;
  forgetLaunch(childRunId: RunId): void;
  requestPromotion(): void;
  close(): Promise<void>;
}

export function createSubagentAdmissionController(
  options: {
    policy?: SubagentConcurrencyPolicy;
  } = {},
): SubagentAdmissionController {
  if (options.policy !== undefined) {
    resolveMaxConcurrentChildren(options.policy, false);
  }
  const treeCapacityByRunState = new WeakMap<
    object,
    SubagentTreeCapacityState
  >();
  const capacityChangeListeners = new Set<() => void>();

  return {
    reserveSubagentLaunchSlots({
      runState,
      requestedChildren,
      ultraReasoning,
      transferable,
      transferExistingReservation,
    }) {
      let treeCapacityState = treeCapacityByRunState.get(runState);
      if (treeCapacityState === undefined) {
        treeCapacityState = {
          activeLeaseIds: new Set<string>(),
          maxConcurrentChildren: resolveMaxConcurrentChildren(
            options.policy,
            ultraReasoning ?? false,
          ),
          transferableLeaseIds: new Set<string>(),
        };
        treeCapacityByRunState.set(runState, treeCapacityState);
      }
      return reserveSlots({
        runState,
        requestedChildren,
        transferable: transferable === true,
        transferExistingReservation: transferExistingReservation === true,
        treeCapacityState,
        treeCapacityByRunState,
        capacityChangeListeners,
      });
    },
    subscribeToCapacityChanges(listener) {
      capacityChangeListeners.add(listener);
      return () => {
        capacityChangeListeners.delete(listener);
      };
    },
  };
}

export function createSubagentLaunchPromotionController(args: {
  admission: SubagentAdmissionController;
  launchRequests: SubagentLaunchRequestStore;
}): SubagentLaunchPromotionController {
  const registrations = new Map<RunId, DeferredSubagentLaunchRegistration>();
  let closed = false;
  let drainRunning = false;
  let drainScheduled = false;
  let drainAgain = false;
  let drainPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const schedulePromotion = (): void => {
    if (closed) {
      return;
    }
    drainAgain = true;
    if (drainRunning || drainScheduled) {
      return;
    }
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      const currentDrain = drainPromotionQueue();
      drainPromise = currentDrain;
      runDetached('agent/subagent-promotion-drain', () =>
        currentDrain.then(
          () => {
            if (drainPromise === currentDrain) {
              drainPromise = undefined;
            }
          },
          (error: unknown) => {
            logger.error(
              'durable subagent promotion drain failed:',
              getErrorMessage(error),
            );
          },
        ),
      );
    });
  };

  const unsubscribeCapacityChanges =
    args.admission.subscribeToCapacityChanges?.(schedulePromotion) ??
    (() => {});

  async function drainPromotionQueue(): Promise<void> {
    if (closed || drainRunning) {
      return;
    }
    drainRunning = true;
    try {
      do {
        drainAgain = false;
        let queuedRequests: readonly DurableSubagentLaunchRequest[];
        try {
          queuedRequests =
            args.launchRequests.readQueuedSubagentLaunchRequests();
        } catch (error: unknown) {
          logger.error(
            'durable subagent promotion queue read failed:',
            getErrorMessage(error),
          );
          return;
        }

        const queuedIds = new Set(
          queuedRequests.map((request) => request.childRunId),
        );
        for (const childRunId of registrations.keys()) {
          if (!queuedIds.has(childRunId)) {
            registrations.delete(childRunId);
          }
        }

        const groups = groupQueuedLaunchRequests(queuedRequests);
        for (const group of groups) {
          await promoteQueuedLaunchGroup(group);
        }
      } while (drainAgain && !closed);
    } finally {
      drainRunning = false;
      if (drainAgain && !closed) {
        schedulePromotion();
      }
    }
  }

  /**
   * 한 그룹의 승격. 그룹은 함께 입장하거나 함께 남는다 — 부분 승격은 부모의
   * 정원 소유권을 쪼개므로 어느 단계에서 막히든 이 그룹만 그대로 되돌린다.
   */
  async function promoteQueuedLaunchGroup(
    group: readonly DurableSubagentLaunchRequest[],
  ): Promise<void> {
    const groupRegistrations = group.map((request) =>
      registrations.get(request.childRunId),
    );
    if (groupRegistrations.some((registration) => !registration)) {
      return;
    }
    const runnableRegistrations = groupRegistrations.filter(
      (registration): registration is DeferredSubagentLaunchRegistration =>
        registration !== undefined,
    );
    const parentRunState = runnableRegistrations[0]?.parentRunState;
    const ultraReasoning = runnableRegistrations[0]?.ultraReasoning;
    if (
      parentRunState === undefined ||
      ultraReasoning === undefined ||
      runnableRegistrations.some(
        (registration) =>
          registration.parentRunState !== parentRunState ||
          registration.ultraReasoning !== ultraReasoning,
      )
    ) {
      logger.error(
        'durable subagent promotion group has inconsistent parent runtime ownership',
      );
      return;
    }

    const admission = args.admission.reserveSubagentLaunchSlots({
      runState: parentRunState,
      requestedChildren: runnableRegistrations.length,
      ultraReasoning,
      transferable: true,
    });
    if (!admission.ok) {
      return;
    }
    for (const request of group) {
      registrations.delete(request.childRunId);
    }
    try {
      const starts = runnableRegistrations.map((registration) =>
        registration.start(),
      );
      const results = await Promise.allSettled(starts);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.error(
            'deferred subagent promotion start failed:',
            getErrorMessage(result.reason),
          );
        }
      }
    } finally {
      admission.reservation.release();
    }
  }

  return {
    deferLaunch({ registration, deferReason }) {
      const [deferred] = args.launchRequests.markSubagentLaunchDeferredBatch({
        childRunIds: [registration.childRunId],
        deferReason,
      });
      if (deferred === undefined) {
        throw new Error(
          `deferred subagent launch disappeared: ${registration.childRunId}`,
        );
      }
      registrations.set(registration.childRunId, registration);
      schedulePromotion();
      return deferred;
    },
    restoreQueuedLaunch(registration) {
      if (closed) {
        throw new Error('subagent launch promotion controller is closed');
      }
      const queued = args.launchRequests.readSubagentLaunchRequestByChildRunId(
        registration.childRunId,
      );
      if (queued?.launchState !== 'queued') {
        throw new Error(
          `subagent launch is not queued for restoration: ${registration.childRunId}`,
        );
      }
      registrations.set(registration.childRunId, registration);
      schedulePromotion();
      return queued;
    },
    forgetLaunch(childRunId) {
      registrations.delete(childRunId);
      schedulePromotion();
    },
    requestPromotion: schedulePromotion,
    close() {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closed = true;
      registrations.clear();
      unsubscribeCapacityChanges();
      closePromise = (async () => {
        await drainPromise;
      })();
      return closePromise;
    },
  };
}

function groupQueuedLaunchRequests(
  requests: readonly DurableSubagentLaunchRequest[],
): readonly (readonly DurableSubagentLaunchRequest[])[] {
  const groups = new Map<string, DurableSubagentLaunchRequest[]>();
  for (const request of requests) {
    const groupKey =
      request.batchId === null
        ? `child:${request.childRunId}`
        : `batch:${request.batchId}`;
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, [request]);
    } else {
      group.push(request);
    }
  }
  return [...groups.values()];
}

export function resolveSubagentConcurrencyPolicyFromEnv(
  env: SubagentConcurrencyEnv = process.env,
): SubagentConcurrencyPolicy | undefined {
  const raw = env[SUBAGENT_BACKGROUND_CAPACITY_ENV];
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();
  if (value === 'unlimited') {
    return { maxConcurrentChildren: null };
  }
  if (!UNSIGNED_BASE_10_INTEGER_PATTERN.test(value)) {
    throwInvalidSubagentBackgroundCapacity(value);
  }

  const maxConcurrentChildren = Number(value);
  if (
    !Number.isSafeInteger(maxConcurrentChildren) ||
    maxConcurrentChildren < 1
  ) {
    throwInvalidSubagentBackgroundCapacity(value);
  }

  return { maxConcurrentChildren };
}

function throwInvalidSubagentBackgroundCapacity(value: string): never {
  throw new Error(
    `invalid ${SUBAGENT_BACKGROUND_CAPACITY_ENV}: ${value || 'empty'}`,
  );
}

function buildTooManyChildRunsMessage(effectiveMax: number): string {
  return `maximum ${effectiveMax} concurrent descendant agents allowed per run tree`;
}

function resolveMaxConcurrentChildren(
  policy: SubagentConcurrencyPolicy | undefined,
  ultraReasoning: boolean,
): number | null {
  const configuredMax =
    policy && 'maxConcurrentChildren' in policy
      ? policy.maxConcurrentChildren
      : ultraReasoning
        ? DEFAULT_ULTRA_SUBAGENT_TREE_CONCURRENCY
        : null;
  if (configuredMax === null) {
    return null;
  }
  if (!Number.isSafeInteger(configuredMax) || configuredMax < 1) {
    throw new Error(
      `invalid subagent maxConcurrentChildren: ${String(configuredMax)}`,
    );
  }
  return configuredMax;
}

function reserveSlots(args: {
  runState: ToolRunState;
  requestedChildren: number;
  transferable: boolean;
  transferExistingReservation: boolean;
  treeCapacityState: SubagentTreeCapacityState;
  treeCapacityByRunState: WeakMap<object, SubagentTreeCapacityState>;
  capacityChangeListeners: ReadonlySet<() => void>;
}): SubagentLaunchAdmission {
  // Admission and reservation mutation must stay synchronous so capacity is observed atomically.
  const {
    runState,
    requestedChildren,
    transferable,
    transferExistingReservation,
    treeCapacityState,
    treeCapacityByRunState,
    capacityChangeListeners,
  } = args;
  const { activeLeaseIds, maxConcurrentChildren, transferableLeaseIds } =
    treeCapacityState;
  if (!Number.isInteger(requestedChildren) || requestedChildren < 1) {
    throw new Error(
      `invalid subagent requestedChildren: ${String(requestedChildren)}`,
    );
  }
  if (transferExistingReservation && requestedChildren !== 1) {
    throw new Error(
      `invalid subagent reservation transfer count: ${String(requestedChildren)}`,
    );
  }

  const transferredReservationId = transferExistingReservation
    ? transferOneExistingReservation(
        runState,
        activeLeaseIds,
        transferableLeaseIds,
      )
    : undefined;
  if (transferredReservationId) {
    return buildAdmittedReservation({
      runState,
      reservationIds: [transferredReservationId],
      activeLeaseIds,
      transferableLeaseIds,
      treeCapacityState,
      treeCapacityByRunState,
      capacityChangeListeners,
    });
  }

  if (
    maxConcurrentChildren !== null &&
    Math.max(activeLeaseIds.size, countActiveBackgroundChildren(runState)) +
      requestedChildren >
      maxConcurrentChildren
  ) {
    return {
      ok: false,
      errorCode: 'too_many_child_runs',
      error: buildTooManyChildRunsMessage(maxConcurrentChildren),
      effectiveMax: maxConcurrentChildren,
    };
  }

  const reservationIds = Array.from({ length: requestedChildren }, () =>
    randomUUID(),
  );
  for (const reservationId of reservationIds) {
    runState.backgroundChildLaunchReservationIds.add(reservationId);
    activeLeaseIds.add(reservationId);
    if (transferable) {
      transferableLeaseIds.add(reservationId);
    }
  }

  return buildAdmittedReservation({
    runState,
    reservationIds,
    activeLeaseIds,
    transferableLeaseIds,
    treeCapacityState,
    treeCapacityByRunState,
    capacityChangeListeners,
  });
}

function transferOneExistingReservation(
  runState: ToolRunState,
  activeLeaseIds: Set<string>,
  transferableLeaseIds: Set<string>,
): string | undefined {
  const existingReservationId = Array.from(
    runState.backgroundChildLaunchReservationIds,
  ).find((reservationId) => transferableLeaseIds.has(reservationId));
  if (!existingReservationId) {
    return undefined;
  }

  runState.backgroundChildLaunchReservationIds.delete(existingReservationId);
  activeLeaseIds.delete(existingReservationId);
  transferableLeaseIds.delete(existingReservationId);
  const claimedReservationId = randomUUID();
  runState.backgroundChildLaunchReservationIds.add(claimedReservationId);
  activeLeaseIds.add(claimedReservationId);
  return claimedReservationId;
}

function buildAdmittedReservation(args: {
  runState: ToolRunState;
  reservationIds: readonly string[];
  activeLeaseIds: Set<string>;
  transferableLeaseIds: Set<string>;
  treeCapacityState: SubagentTreeCapacityState;
  treeCapacityByRunState: WeakMap<object, SubagentTreeCapacityState>;
  capacityChangeListeners: ReadonlySet<() => void>;
}): Extract<SubagentLaunchAdmission, { ok: true }> {
  const {
    runState,
    reservationIds,
    activeLeaseIds,
    transferableLeaseIds,
    treeCapacityState,
    treeCapacityByRunState,
    capacityChangeListeners,
  } = args;
  let activated = false;
  let activatedChildRunState: object | undefined;
  let released = false;
  return {
    ok: true,
    reservation: {
      activate(childRunState) {
        if (activated || released) {
          return;
        }
        activated = true;
        activatedChildRunState = childRunState;
        treeCapacityByRunState.set(childRunState, treeCapacityState);
        for (const reservationId of reservationIds) {
          runState.backgroundChildLaunchReservationIds.delete(reservationId);
          transferableLeaseIds.delete(reservationId);
        }
      },
      release() {
        if (released) {
          return;
        }
        released = true;
        if (
          activatedChildRunState !== undefined &&
          treeCapacityByRunState.get(activatedChildRunState) ===
            treeCapacityState
        ) {
          treeCapacityByRunState.delete(activatedChildRunState);
        }
        let releasedCapacity = false;
        for (const reservationId of reservationIds) {
          runState.backgroundChildLaunchReservationIds.delete(reservationId);
          transferableLeaseIds.delete(reservationId);
          releasedCapacity =
            activeLeaseIds.delete(reservationId) || releasedCapacity;
        }
        if (releasedCapacity) {
          for (const listener of capacityChangeListeners) {
            listener();
          }
        }
      },
    },
  };
}
