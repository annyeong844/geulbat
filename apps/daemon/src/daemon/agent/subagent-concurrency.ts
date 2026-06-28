import { randomUUID } from 'node:crypto';
import type { ToolRunState } from '../runtime-contracts.js';
import { countActiveBackgroundChildren } from './runtime/run-state.js';
import type { SubagentLaunchReservation } from '../subagent-runtime-contracts.js';

export const SUBAGENT_BACKGROUND_CAPACITY_ENV =
  'GEULBAT_SUBAGENT_BACKGROUND_CAPACITY';

type SubagentConcurrencyEnv = Readonly<
  Partial<Record<typeof SUBAGENT_BACKGROUND_CAPACITY_ENV, string | undefined>>
>;

const UNSIGNED_BASE_10_INTEGER_PATTERN = /^\d+$/u;

export interface SubagentConcurrencyPolicy {
  maxConcurrentChildren?: number | null;
}

export type SubagentLaunchAdmission =
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
    transferExistingReservation?: boolean;
  }): SubagentLaunchAdmission;
}

export function createSubagentAdmissionController(
  options: {
    policy?: SubagentConcurrencyPolicy;
  } = {},
): SubagentAdmissionController {
  const maxConcurrentChildren = resolveMaxConcurrentChildren(options.policy);

  return {
    reserveSubagentLaunchSlots({
      runState,
      requestedChildren,
      transferExistingReservation,
    }) {
      return reserveSlots({
        runState,
        requestedChildren,
        transferExistingReservation: transferExistingReservation === true,
        maxConcurrentChildren,
      });
    },
  };
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
  return `maximum ${effectiveMax} concurrent child agents allowed`;
}

function resolveMaxConcurrentChildren(
  policy: SubagentConcurrencyPolicy | undefined,
): number | null {
  const configuredMax =
    policy && 'maxConcurrentChildren' in policy
      ? policy.maxConcurrentChildren
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
  transferExistingReservation: boolean;
  maxConcurrentChildren: number | null;
}): SubagentLaunchAdmission {
  // Admission and reservation mutation must stay synchronous so capacity is observed atomically.
  const {
    runState,
    requestedChildren,
    transferExistingReservation,
    maxConcurrentChildren,
  } = args;
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
    ? transferOneExistingReservation(runState)
    : undefined;
  if (transferredReservationId) {
    return buildAdmittedReservation(runState, [transferredReservationId]);
  }

  if (
    maxConcurrentChildren !== null &&
    countActiveBackgroundChildren(runState) + requestedChildren >
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
  }

  return buildAdmittedReservation(runState, reservationIds);
}

function transferOneExistingReservation(
  runState: ToolRunState,
): string | undefined {
  const [existingReservationId] =
    runState.backgroundChildLaunchReservationIds.values();
  if (!existingReservationId) {
    return undefined;
  }

  runState.backgroundChildLaunchReservationIds.delete(existingReservationId);
  const claimedReservationId = randomUUID();
  runState.backgroundChildLaunchReservationIds.add(claimedReservationId);
  return claimedReservationId;
}

function buildAdmittedReservation(
  runState: ToolRunState,
  reservationIds: readonly string[],
): Extract<SubagentLaunchAdmission, { ok: true }> {
  let released = false;
  return {
    ok: true,
    reservation: {
      release() {
        if (released) {
          return;
        }
        released = true;
        for (const reservationId of reservationIds) {
          runState.backgroundChildLaunchReservationIds.delete(reservationId);
        }
      },
    },
  };
}
