import { randomUUID } from 'node:crypto';

import type {
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
  PtcSessionDockerResult,
} from '../../lab/session/session-docker-contract.js';
import { createPtcLogger } from '../../shared/logger.js';

const logger = createPtcLogger('execute-code/standby-pool');

export const PTC_EXECUTE_CODE_STANDBY_ENABLED_ENV =
  'GEULBAT_PTC_STANDBY_ENABLED' as const;
export const PTC_EXECUTE_CODE_STANDBY_READY_TARGET_ENV =
  'GEULBAT_PTC_STANDBY_READY_TARGET' as const;
export const PTC_EXECUTE_CODE_STANDBY_MAX_CONCURRENT_REFILLS_ENV =
  'GEULBAT_PTC_STANDBY_MAX_CONCURRENT_REFILLS' as const;

export type PtcExecuteCodeStandbyPlacementConfig =
  | { enabled: false }
  | {
      enabled: true;
      readySlotTarget: number;
      maxConcurrentRefills: number;
    };

export type PtcExecuteCodeStandbyIdentity = PtcSessionDockerIdentity & {
  ephemeralBurstId: `ptc_burst_${string}`;
};

export interface PtcExecuteCodeStandbyPool {
  refill(
    identity: PtcSessionDockerIdentity,
    canProvisionSlot?: () => boolean,
  ): Promise<void>;
  claimReady(
    identity: PtcSessionDockerIdentity,
  ): PtcExecuteCodeStandbyIdentity | undefined;
  readInventory(identity: PtcSessionDockerIdentity): {
    readySlotCount: number;
    reservedSlotCount: number;
  };
  close(): Promise<PtcSessionDockerResult<void>>;
}

interface StandbySlot {
  identity: PtcExecuteCodeStandbyIdentity;
}

export function resolvePtcExecuteCodeStandbyPlacementConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PtcExecuteCodeStandbyPlacementConfig | undefined {
  const enabledRaw = env[PTC_EXECUTE_CODE_STANDBY_ENABLED_ENV];
  const readyTargetRaw = env[PTC_EXECUTE_CODE_STANDBY_READY_TARGET_ENV];
  const maxRefillsRaw =
    env[PTC_EXECUTE_CODE_STANDBY_MAX_CONCURRENT_REFILLS_ENV];
  if (enabledRaw === undefined) {
    if (readyTargetRaw !== undefined || maxRefillsRaw !== undefined) {
      throw new Error(
        `PTC execute_code standby settings require ${PTC_EXECUTE_CODE_STANDBY_ENABLED_ENV}=true`,
      );
    }
    return undefined;
  }
  const enabled = enabledRaw.trim();
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error(`invalid ${PTC_EXECUTE_CODE_STANDBY_ENABLED_ENV}`);
  }
  if (enabled === 'false') {
    if (readyTargetRaw !== undefined || maxRefillsRaw !== undefined) {
      throw new Error(
        `PTC execute_code standby settings require ${PTC_EXECUTE_CODE_STANDBY_ENABLED_ENV}=true`,
      );
    }
    return { enabled: false };
  }
  return {
    enabled: true,
    readySlotTarget: readRequiredPositiveIntegerEnv(
      env,
      PTC_EXECUTE_CODE_STANDBY_READY_TARGET_ENV,
    ),
    maxConcurrentRefills: readRequiredPositiveIntegerEnv(
      env,
      PTC_EXECUTE_CODE_STANDBY_MAX_CONCURRENT_REFILLS_ENV,
    ),
  };
}

export function createPtcExecuteCodeStandbyPool(args: {
  config: Extract<PtcExecuteCodeStandbyPlacementConfig, { enabled: true }>;
  perIdentityReadyLimit: number;
  sessionManager: PtcSessionDockerManager;
}): PtcExecuteCodeStandbyPool {
  validateStandbyPoolConfig(args.config, args.perIdentityReadyLimit);
  const readySlotsByIdentity = new Map<string, StandbySlot[]>();
  const inFlightRefills = new Set<Promise<boolean>>();
  const inFlightRefillCountByIdentity = new Map<string, number>();
  let readySlotCount = 0;
  let state: 'open' | 'closing' | 'closed' = 'open';
  let firstCleanupFailure: PtcSessionDockerResult<void> | undefined;
  let closePromise: Promise<PtcSessionDockerResult<void>> | undefined;

  async function refill(
    identity: PtcSessionDockerIdentity,
    canProvisionSlot?: () => boolean,
  ): Promise<void> {
    const baseIdentity = withoutEphemeralBurstId(identity);
    const identityKey = buildPtcExecuteCodeStandbyIdentityKey(baseIdentity);
    let madeProgress = true;
    while (state === 'open' && madeProgress) {
      const scheduled: Promise<boolean>[] = [];
      while (
        canScheduleRefill(identityKey) &&
        (canProvisionSlot === undefined || canProvisionSlot())
      ) {
        const refillPromise = prewarmSlot(baseIdentity, identityKey);
        inFlightRefills.add(refillPromise);
        incrementInFlightRefillCount(identityKey);
        void refillPromise.finally(() => {
          inFlightRefills.delete(refillPromise);
          decrementInFlightRefillCount(identityKey);
        });
        scheduled.push(refillPromise);
      }
      if (scheduled.length === 0) {
        const currentRefills = [...inFlightRefills];
        if (currentRefills.length === 0) {
          return;
        }
        const outcomes = await Promise.all(currentRefills);
        madeProgress = outcomes.some(Boolean);
        continue;
      }
      const outcomes = await Promise.all(scheduled);
      madeProgress = outcomes.some(Boolean);
    }
  }

  function claimReady(
    identity: PtcSessionDockerIdentity,
  ): PtcExecuteCodeStandbyIdentity | undefined {
    if (state !== 'open') {
      return undefined;
    }
    const baseIdentity = withoutEphemeralBurstId(identity);
    const identityKey = buildPtcExecuteCodeStandbyIdentityKey(baseIdentity);
    const slots = readySlotsByIdentity.get(identityKey);
    const slot = slots?.shift();
    if (slot === undefined) {
      return undefined;
    }
    readySlotCount -= 1;
    if (slots === undefined || slots.length === 0) {
      readySlotsByIdentity.delete(identityKey);
    }
    return {
      ...baseIdentity,
      ephemeralBurstId: slot.identity.ephemeralBurstId,
    };
  }

  function readInventory(identity: PtcSessionDockerIdentity): {
    readySlotCount: number;
    reservedSlotCount: number;
  } {
    const identityKey = buildPtcExecuteCodeStandbyIdentityKey(
      withoutEphemeralBurstId(identity),
    );
    return {
      readySlotCount: readySlotsByIdentity.get(identityKey)?.length ?? 0,
      reservedSlotCount: readySlotCount + inFlightRefills.size,
    };
  }

  function canScheduleRefill(identityKey: string): boolean {
    const readyForIdentity = readySlotsByIdentity.get(identityKey)?.length ?? 0;
    const inFlightForIdentity =
      inFlightRefillCountByIdentity.get(identityKey) ?? 0;
    return (
      state === 'open' &&
      readySlotCount + inFlightRefills.size < args.config.readySlotTarget &&
      inFlightRefills.size < args.config.maxConcurrentRefills &&
      readyForIdentity + inFlightForIdentity < args.perIdentityReadyLimit
    );
  }

  async function prewarmSlot(
    baseIdentity: PtcSessionDockerIdentity,
    identityKey: string,
  ): Promise<boolean> {
    const identity: PtcExecuteCodeStandbyIdentity = {
      ...baseIdentity,
      ephemeralBurstId: `ptc_burst_${randomUUID()}`,
    };
    try {
      const created = await args.sessionManager.getOrCreate(identity);
      if (!created.ok) {
        logger
          .withContext({ reasonCode: created.reasonCode })
          .warn('PTC execute_code standby refill failed');
        return false;
      }
      if (state !== 'open') {
        const closed = await args.sessionManager.close(identity);
        recordCleanupFailure(closed);
        return false;
      }
      const slots = readySlotsByIdentity.get(identityKey) ?? [];
      slots.push({ identity });
      readySlotsByIdentity.set(identityKey, slots);
      readySlotCount += 1;
      return true;
    } catch (error: unknown) {
      logger
        .withContext({
          errorName: error instanceof Error ? error.name : 'unknown',
        })
        .warn('PTC execute_code standby refill threw');
      return false;
    }
  }

  async function close(): Promise<PtcSessionDockerResult<void>> {
    closePromise ??= closeOnce();
    return await closePromise;
  }

  async function closeOnce(): Promise<PtcSessionDockerResult<void>> {
    state = 'closing';
    await Promise.allSettled([...inFlightRefills]);
    for (const slots of readySlotsByIdentity.values()) {
      for (const slot of slots) {
        const closed = await args.sessionManager.close(slot.identity);
        recordCleanupFailure(closed);
      }
    }
    readySlotsByIdentity.clear();
    readySlotCount = 0;
    state = 'closed';
    return firstCleanupFailure ?? { ok: true, value: undefined };
  }

  function recordCleanupFailure(result: PtcSessionDockerResult<void>): void {
    if (!result.ok && firstCleanupFailure === undefined) {
      firstCleanupFailure = result;
    }
  }

  function incrementInFlightRefillCount(identityKey: string): void {
    inFlightRefillCountByIdentity.set(
      identityKey,
      (inFlightRefillCountByIdentity.get(identityKey) ?? 0) + 1,
    );
  }

  function decrementInFlightRefillCount(identityKey: string): void {
    const next = (inFlightRefillCountByIdentity.get(identityKey) ?? 0) - 1;
    if (next <= 0) {
      inFlightRefillCountByIdentity.delete(identityKey);
      return;
    }
    inFlightRefillCountByIdentity.set(identityKey, next);
  }

  return { refill, claimReady, readInventory, close };
}

function withoutEphemeralBurstId(
  identity: PtcSessionDockerIdentity,
): PtcSessionDockerIdentity {
  const baseIdentity: PtcSessionDockerIdentity = {
    ...identity,
    ...(identity.sdkProjectionMount === undefined
      ? {}
      : { sdkProjectionMount: { ...identity.sdkProjectionMount } }),
  };
  delete baseIdentity.ephemeralBurstId;
  return baseIdentity;
}

export function buildPtcExecuteCodeStandbyIdentityKey(
  identity: PtcSessionDockerIdentity,
): string {
  return [
    identity.stateRoot,
    identity.trustContextId,
    identity.sdkProjectionMount?.hostRootPath ?? '',
    identity.sdkProjectionMount?.containerRootPath ?? '',
    identity.sdkProjectionMount?.mountPolicyId ?? '',
    identity.sdkProjectionMount?.sdkVersion ?? '',
    identity.sdkProjectionMount?.sdkProjectionHash ?? '',
    identity.sdkProjectionMount?.policyId ?? '',
    identity.sdkProjectionMount?.importSpecifier ?? '',
  ].join('\u0000');
}

function validateStandbyPoolConfig(
  config: Extract<PtcExecuteCodeStandbyPlacementConfig, { enabled: true }>,
  perIdentityReadyLimit: number,
): void {
  if (
    !Number.isSafeInteger(config.readySlotTarget) ||
    config.readySlotTarget < 1
  ) {
    throw new Error('PTC execute_code standby ready target is invalid');
  }
  if (
    !Number.isSafeInteger(config.maxConcurrentRefills) ||
    config.maxConcurrentRefills < 1
  ) {
    throw new Error('PTC execute_code standby refill concurrency is invalid');
  }
  if (
    !Number.isSafeInteger(perIdentityReadyLimit) ||
    perIdentityReadyLimit < 1
  ) {
    throw new Error('PTC execute_code standby per-identity limit is invalid');
  }
}

function readRequiredPositiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number {
  const raw = env[name];
  if (raw === undefined) {
    throw new Error(`${name} is required when standby placement is enabled`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}
