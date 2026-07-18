import { randomUUID } from 'node:crypto';
import type { createPtcLabSessionBatchCommandRunner } from '../../lab/shell/lab-session-batch-command.js';
import type {
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
  PtcSessionDockerResourceRequirements,
} from '../../lab/session/session-docker-contract.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodePlacementContinuityProvenance,
  PtcExecuteCodePlacementResourceBudget,
  PtcExecuteCodePlacementResourceSnapshotRef,
} from './execute-code-runtime-contract.js';
import {
  buildPtcExecuteCodeStandbyIdentityKey,
  type PtcExecuteCodeStandbyIdentity,
  type PtcExecuteCodeStandbyPool,
} from './execute-code-standby-pool.js';

type MaybePromise<T> = T | Promise<T>;

const PTC_EXECUTE_CODE_READ_ONLY_CALLBACK_EFFECTS = Object.freeze([
  'read_only',
] as const);

export const PTC_EXECUTE_CODE_BURST_ENABLED_ENV =
  'GEULBAT_PTC_BURST_ENABLED' as const;
export const PTC_EXECUTE_CODE_BURST_GLOBAL_CONCURRENCY_ENV =
  'GEULBAT_PTC_BURST_GLOBAL_CONCURRENCY' as const;
export const PTC_EXECUTE_CODE_BURST_PER_IDENTITY_CONCURRENCY_ENV =
  'GEULBAT_PTC_BURST_PER_IDENTITY_CONCURRENCY' as const;

export type PtcExecuteCodeBurstPlacementConfig =
  | { enabled: false }
  | { enabled: true };

export type PtcExecuteCodePlacementBatchRunner = ReturnType<
  typeof createPtcLabSessionBatchCommandRunner
>;

type PtcExecuteCodePlacementOwnerKind = 'root_main' | 'child';

type PtcExecuteCodePlacementContinuity =
  | {
      kind: 'independent';
      reason: 'self_contained' | 'map_shard' | 'read_only_analysis';
    }
  | {
      kind: 'requires_warm_continuity';
      handleId: string;
      reason: 'warm_interpreter' | 'warm_fs' | 'warm_memo';
    }
  | { kind: 'defer_to_warm'; reason: 'unclassified' | 'policy_fail_closed' };

type PtcExecuteCodePlacementSelectedLane = 'warm_session' | 'cold_burst';

type PtcExecuteCodePlacementDecisionReason =
  | 'warm_available'
  | 'warm_continuity_required'
  | 'independence_not_proven'
  | 'callback_effect_requires_warm'
  | 'burst_not_enabled_yet'
  | 'cold_burst_spillover'
  | 'child_cold_burst';

interface PtcExecuteCodePlacementObservationBase {
  continuity: PtcExecuteCodePlacementContinuity;
  callbackEffectPolicy: PtcExecuteCodePlacementCallbackEffectPolicy;
  burstEligible: boolean;
  selectedLane: PtcExecuteCodePlacementSelectedLane;
  reason: PtcExecuteCodePlacementDecisionReason;
  resourceSnapshotRef?: PtcExecuteCodePlacementResourceSnapshotRef;
}

type PtcExecuteCodePlacementObservation =
  | (PtcExecuteCodePlacementObservationBase & {
      executionKind: 'batch_command';
    })
  | (PtcExecuteCodePlacementObservationBase & {
      executionKind: 'detached_cell';
      cellId: PtcExecuteCodeCellId;
    });

interface PtcExecuteCodePlacementDecision {
  selectedLane: PtcExecuteCodePlacementSelectedLane;
  reason: PtcExecuteCodePlacementDecisionReason;
}

interface PtcExecuteCodePlacementPreflightRecord {
  input: PtcExecuteCodePlacementObservation;
  placementDecision: PtcExecuteCodePlacementDecision;
  burstEligible: boolean;
  selectedLane: PtcExecuteCodePlacementSelectedLane;
  reason: PtcExecuteCodePlacementDecisionReason;
  resourceSnapshotRef?: PtcExecuteCodePlacementResourceSnapshotRef;
}

export interface PtcExecuteCodePlacementCallbackEffectPolicy {
  allowedEffects: readonly ('read_only' | 'workspace_write')[];
  mutationPolicy: 'none' | 'conflict_error';
  callbackToolCount: number;
  writeCallbackToolCount: number;
  source: 'ptc_callback_surface';
}

interface PtcExecuteCodePlacementRuntimeRequest {
  code: string;
  timeoutMs: number;
  yieldTimeMs?: number;
}

export type PtcExecuteCodePlacementContinuityProvenanceProvider = (
  args:
    | {
        kind: 'batch_command';
        identity: PtcSessionDockerIdentity;
        request: PtcExecuteCodePlacementRuntimeRequest;
      }
    | {
        kind: 'detached_cell';
        cellId: PtcExecuteCodeCellId;
        identity: PtcSessionDockerIdentity;
        request: PtcExecuteCodePlacementRuntimeRequest;
      },
) => PtcExecuteCodePlacementContinuityProvenance | undefined;

interface PtcExecuteCodePlacementBase {
  executionKind: PtcExecuteCodePlacementRequest['kind'];
  continuity: PtcExecuteCodePlacementContinuity;
  observation: PtcExecuteCodePlacementObservation;
  preflight: PtcExecuteCodePlacementPreflightRecord;
  cellId?: PtcExecuteCodeCellId;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
}

interface PtcExecuteCodeWarmSessionPlacement extends PtcExecuteCodePlacementBase {
  kind: 'warm_session';
  lease: PtcExecuteCodeWarmSessionLease;
}

interface PtcExecuteCodeBurstSessionPlacement extends PtcExecuteCodePlacementBase {
  kind: 'burst';
  provisioning: 'standbyRestore' | 'coldCreate';
  identity: PtcSessionDockerIdentity & {
    ephemeralBurstId: `ptc_burst_${string}`;
  };
  lease: PtcExecuteCodeBurstSessionLease;
}

export type PtcExecuteCodeExecutionPlacement =
  | PtcExecuteCodeWarmSessionPlacement
  | PtcExecuteCodeBurstSessionPlacement;

interface PtcExecuteCodeWarmSessionLease {
  leaseId: `ptc_warm_lease_${string}`;
  generation: number;
  shutdownEpoch: number;
  ownerThreadId: string;
}

interface PtcExecuteCodeBurstSessionLease {
  leaseId: `ptc_burst_lease_${string}`;
  generation: number;
  shutdownEpoch: number;
  ownerThreadId: string;
}

type PtcExecuteCodePlacementAcquireFailure = {
  ok: false;
  reasonCode:
    | 'ptc_lab_command_cancelled'
    | 'ptc_lab_session_busy'
    | 'ptc_lab_session_unavailable';
  message: string;
  remediation?: string;
  diagnostics: Record<string, string | number | boolean>;
};

type PtcExecuteCodeSettledPlacementAcquireResult =
  | { ok: true; value: PtcExecuteCodeExecutionPlacement }
  | PtcExecuteCodePlacementAcquireFailure;

export interface PtcExecuteCodeQueuedPlacementAcquisition {
  ok: true;
  queued: true;
  queueId: `ptc_placement_queue_${string}`;
  cancel(this: void): void;
  waitForPlacement: Promise<PtcExecuteCodeSettledPlacementAcquireResult>;
  diagnostics: Record<string, string | number | boolean>;
}

export type PtcExecuteCodePlacementAcquireResult =
  | PtcExecuteCodeSettledPlacementAcquireResult
  | PtcExecuteCodeQueuedPlacementAcquisition;

export type PtcExecuteCodePlacementReleaseResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: 'ptc_execute_code_session_cleanup_failed';
      message: string;
      diagnostics: Record<string, string | number | boolean>;
    };

interface PtcExecuteCodePlacementRequestBase {
  ownerKind: PtcExecuteCodePlacementOwnerKind;
  identity: PtcSessionDockerIdentity;
  continuity: PtcExecuteCodePlacementContinuity;
  callbackEffectPolicy: PtcExecuteCodePlacementCallbackEffectPolicy;
  sessionManager: PtcSessionDockerManager;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
  resourceSnapshotRef?: PtcExecuteCodePlacementResourceSnapshotRef;
  signal?: AbortSignal;
}

interface PtcExecuteCodeBatchPlacementRequest extends PtcExecuteCodePlacementRequestBase {
  kind: 'batch_command';
}

interface PtcExecuteCodeCellPlacementRequest extends PtcExecuteCodePlacementRequestBase {
  kind: 'detached_cell';
  cellId: PtcExecuteCodeCellId;
}

type PtcExecuteCodePlacementRequest =
  | PtcExecuteCodeBatchPlacementRequest
  | PtcExecuteCodeCellPlacementRequest;

interface PendingPlacementAcquire {
  queueId: `ptc_placement_queue_${string}`;
  lane: 'warm_session' | 'cold_burst';
  request: PtcExecuteCodePlacementRequest;
  sequence: number;
  resolve(result: PtcExecuteCodeSettledPlacementAcquireResult): void;
  abortListener?: () => void;
}

interface ActiveBurstPlacement {
  placement: PtcExecuteCodeBurstSessionPlacement;
  cleanup?: Promise<PtcExecuteCodePlacementReleaseResult>;
}

export function resolvePtcExecuteCodeBurstPlacementConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PtcExecuteCodeBurstPlacementConfig | undefined {
  const enabledRaw = env[PTC_EXECUTE_CODE_BURST_ENABLED_ENV];
  const globalRaw = env[PTC_EXECUTE_CODE_BURST_GLOBAL_CONCURRENCY_ENV];
  const perIdentityRaw =
    env[PTC_EXECUTE_CODE_BURST_PER_IDENTITY_CONCURRENCY_ENV];
  if (globalRaw !== undefined || perIdentityRaw !== undefined) {
    throw new Error(
      'PTC execute_code fixed burst concurrency settings are no longer supported; burst admission is resource-aware',
    );
  }
  if (enabledRaw === undefined) {
    return undefined;
  }
  const enabled = enabledRaw.trim();
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error(`invalid ${PTC_EXECUTE_CODE_BURST_ENABLED_ENV}`);
  }
  if (enabled === 'false') {
    return { enabled: false };
  }
  return { enabled: true };
}

export function classifyPtcExecuteCodePlacementContinuity(
  provenance: PtcExecuteCodePlacementContinuityProvenance = {},
): PtcExecuteCodePlacementContinuity {
  const warmHandle = provenance.warmHandles?.[0];
  if (warmHandle !== undefined) {
    return {
      kind: 'requires_warm_continuity',
      handleId: warmHandle.handleId,
      reason: warmHandle.kind,
    };
  }
  if (provenance.policyFailClosed === true) {
    return { kind: 'defer_to_warm', reason: 'policy_fail_closed' };
  }
  if (provenance.independenceProof !== undefined) {
    return {
      kind: 'independent',
      reason: provenance.independenceProof.reason,
    };
  }
  return { kind: 'defer_to_warm', reason: 'unclassified' };
}

export function isPtcExecuteCodePlacementBurstEligible(
  continuity: PtcExecuteCodePlacementContinuity,
  callbackEffectPolicy?: PtcExecuteCodePlacementCallbackEffectPolicy,
): boolean {
  return (
    continuity.kind === 'independent' &&
    (callbackEffectPolicy === undefined ||
      callbackEffectPolicy.allowedEffects.every(
        (effect) => effect === 'read_only',
      ))
  );
}

export function createPtcExecuteCodePlacementObservation(
  args: PtcExecuteCodePlacementRequest,
  decision: PtcExecuteCodePlacementDecision = classifyPtcExecuteCodeWarmPlacementDecision(
    args.continuity,
  ),
): PtcExecuteCodePlacementObservation {
  const base = {
    continuity: args.continuity,
    callbackEffectPolicy: args.callbackEffectPolicy,
    burstEligible: isPtcExecuteCodePlacementBurstEligible(
      args.continuity,
      args.callbackEffectPolicy,
    ),
    selectedLane: decision.selectedLane,
    reason: decision.reason,
    ...(args.resourceSnapshotRef === undefined
      ? {}
      : { resourceSnapshotRef: args.resourceSnapshotRef }),
  } as const;
  if (args.kind === 'detached_cell') {
    return {
      ...base,
      executionKind: args.kind,
      cellId: args.cellId,
    };
  }
  return { ...base, executionKind: args.kind };
}

export function readPtcExecuteCodePlacementObservation(
  placement: PtcExecuteCodeExecutionPlacement,
): PtcExecuteCodePlacementObservation {
  return placement.observation;
}

export function readPtcExecuteCodePlacementDecision(
  input: PtcExecuteCodePlacementObservation,
): PtcExecuteCodePlacementDecision {
  return { selectedLane: input.selectedLane, reason: input.reason };
}

export function createPtcExecuteCodePlacementPreflightRecord(
  input: PtcExecuteCodePlacementObservation,
): PtcExecuteCodePlacementPreflightRecord {
  const placementDecision = readPtcExecuteCodePlacementDecision(input);
  return {
    input,
    placementDecision,
    burstEligible: input.burstEligible,
    selectedLane: placementDecision.selectedLane,
    reason: placementDecision.reason,
    ...(input.resourceSnapshotRef === undefined
      ? {}
      : { resourceSnapshotRef: input.resourceSnapshotRef }),
  };
}

export function classifyPtcExecuteCodeWarmPlacementDecision(
  continuity: PtcExecuteCodePlacementContinuity,
): PtcExecuteCodePlacementDecision {
  switch (continuity.kind) {
    case 'independent':
      return {
        selectedLane: 'warm_session',
        reason: 'burst_not_enabled_yet',
      };
    case 'requires_warm_continuity':
      return {
        selectedLane: 'warm_session',
        reason: 'warm_continuity_required',
      };
    case 'defer_to_warm':
      return {
        selectedLane: 'warm_session',
        reason: 'independence_not_proven',
      };
  }
}

export function createPtcExecuteCodeCallbackEffectPolicy(args: {
  callbackToolCount: number;
  writeCallbackToolCount?: number;
}): PtcExecuteCodePlacementCallbackEffectPolicy {
  const writeCallbackToolCount = args.writeCallbackToolCount ?? 0;
  return Object.freeze({
    allowedEffects:
      writeCallbackToolCount === 0
        ? PTC_EXECUTE_CODE_READ_ONLY_CALLBACK_EFFECTS
        : (['read_only', 'workspace_write'] as const),
    mutationPolicy: writeCallbackToolCount === 0 ? 'none' : 'conflict_error',
    callbackToolCount: args.callbackToolCount,
    writeCallbackToolCount,
    source: 'ptc_callback_surface',
  });
}

export function readPtcExecuteCodePlacementPreflightRecord(
  placement: PtcExecuteCodeExecutionPlacement,
): PtcExecuteCodePlacementPreflightRecord {
  return placement.preflight;
}

export interface PtcExecuteCodePlacementCoordinator {
  acquirePlacement(
    args: PtcExecuteCodePlacementRequest,
  ): MaybePromise<PtcExecuteCodePlacementAcquireResult>;
  releasePlacement(
    placement: PtcExecuteCodeExecutionPlacement,
  ): MaybePromise<void | PtcExecuteCodePlacementReleaseResult>;
  reapPlacements?(): Promise<PtcExecuteCodePlacementReleaseResult>;
  refreshQueuedPlacements?(): void;
  beginShutdown(): void;
  finishShutdown(): void;
}

type PtcExecuteCodeBurstResourceAdmission =
  | { ok: true; budget: PtcExecuteCodePlacementResourceBudget }
  | {
      ok: false;
      budget: PtcExecuteCodePlacementResourceBudget;
      reason: 'resource_budget_unavailable' | 'resource_budget_insufficient';
    };

export function createPtcExecuteCodePlacementCoordinator(
  args: {
    burstConfig?: PtcExecuteCodeBurstPlacementConfig;
    standbyPool?: PtcExecuteCodeStandbyPool;
    placementResourceBudgetProvider?: () => PtcExecuteCodePlacementResourceBudget;
    resourceRequirements?: PtcSessionDockerResourceRequirements;
  } = {},
): PtcExecuteCodePlacementCoordinator {
  const burstConfig = args.burstConfig;
  if (
    (args.placementResourceBudgetProvider === undefined) !==
    (args.resourceRequirements === undefined)
  ) {
    throw new Error(
      'PTC execute_code burst resource budget provider and requirements must be configured together',
    );
  }
  if (args.resourceRequirements !== undefined) {
    validateResourceRequirements(args.resourceRequirements);
  }
  if (
    burstConfig?.enabled === true &&
    args.placementResourceBudgetProvider === undefined
  ) {
    throw new Error(
      'PTC execute_code burst placement requires a resource budget provider',
    );
  }
  if (args.standbyPool !== undefined && burstConfig?.enabled !== true) {
    throw new Error('PTC execute_code standby pool requires burst placement');
  }
  let activeWarmPlacement: PtcExecuteCodeWarmSessionPlacement | undefined;
  let retainedWarmPlacement: PtcExecuteCodeWarmSessionPlacement | undefined;
  let warmTransition:
    | Promise<PtcExecuteCodeSettledPlacementAcquireResult>
    | undefined;
  const activeBurstPlacements = new Map<string, ActiveBurstPlacement>();
  const pendingWarmQueue: PendingPlacementAcquire[] = [];
  const pendingBurstByThread = new Map<string, PendingPlacementAcquire[]>();
  const burstFairnessOrder: string[] = [];
  let lastWarmGeneration = 0;
  let lastBurstGeneration = 0;
  let queueSequence = 0;
  let burstFairnessCursor = 0;
  let shutdownState: 'open' | 'closing' | 'closed' = 'open';
  let shutdownEpoch = 0;

  function acquirePlacement(
    request: PtcExecuteCodePlacementRequest,
  ): MaybePromise<PtcExecuteCodePlacementAcquireResult> {
    const rejected = rejectUnavailableAcquire(request);
    if (rejected !== undefined) {
      return rejected;
    }
    if (
      request.ownerKind === 'root_main' &&
      activeWarmPlacement === undefined &&
      warmTransition === undefined
    ) {
      return acquireWarmPlacement(request);
    }

    const burstEligible = isPtcExecuteCodePlacementBurstEligible(
      request.continuity,
      request.callbackEffectPolicy,
    );
    const resourceAdmission =
      burstEligible && burstConfig?.enabled === true
        ? readBurstResourceAdmission(request.identity)
        : undefined;
    if (resourceAdmission?.ok === true) {
      return {
        ok: true,
        value: commitBurstPlacement(
          withResourceSnapshotRef(request, resourceAdmission.budget),
        ),
      };
    }

    if (request.ownerKind === 'child' && !burstEligible) {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'Child-owned PTC work requires an independent cold placement',
        remediation:
          'Run only positively-proven independent read-only PTC work from a child, or return the work to the root/main owner.',
        diagnostics: {
          placementOwnerKind: request.ownerKind,
          continuityKind: request.continuity.kind,
          burstEligible: false,
        },
      };
    }

    if (request.kind === 'detached_cell' && burstConfig?.enabled === true) {
      if (burstEligible) {
        return enqueuePlacement(
          request,
          'cold_burst',
          resourceAdmission?.ok === false
            ? resourceAdmission.reason
            : undefined,
        );
      }
      if (request.ownerKind === 'root_main') {
        return enqueuePlacement(request, 'warm_session');
      }
    }

    return busyPlacementFailure(
      request,
      burstEligible,
      burstConfig,
      activeWarmPlacement,
    );
  }

  function acquireWarmPlacement(
    request: PtcExecuteCodePlacementRequest,
  ): MaybePromise<PtcExecuteCodeSettledPlacementAcquireResult> {
    const reason = readWarmDecisionReason(
      request,
      burstConfig?.enabled === true,
    );
    if (
      retainedWarmPlacement === undefined ||
      isSameRetainedWarmIdentity(retainedWarmPlacement, request)
    ) {
      return { ok: true, value: commitWarmPlacement(request, reason) };
    }

    const previous = retainedWarmPlacement;
    const transition = replaceRetainedWarmPlacement(previous, request, reason);
    warmTransition = transition;
    void transition.then(
      () => finishWarmTransition(transition),
      () => finishWarmTransition(transition),
    );
    return transition;
  }

  function finishWarmTransition(
    transition: Promise<PtcExecuteCodeSettledPlacementAcquireResult>,
  ): void {
    if (warmTransition !== transition) {
      return;
    }
    warmTransition = undefined;
    drainWarmQueue();
  }

  async function replaceRetainedWarmPlacement(
    previous: PtcExecuteCodeWarmSessionPlacement,
    request: PtcExecuteCodePlacementRequest,
    reason: PtcExecuteCodePlacementDecisionReason,
  ): Promise<PtcExecuteCodeSettledPlacementAcquireResult> {
    try {
      const closed = await previous.sessionManager.close(previous.identity);
      if (!closed.ok) {
        return warmReplacementFailure(request, closed.reasonCode);
      }
    } catch (error: unknown) {
      return warmReplacementFailure(
        request,
        error instanceof Error ? error.name : 'unknown',
      );
    }

    if (retainedWarmPlacement === previous) {
      retainedWarmPlacement = undefined;
    }
    const rejected = rejectUnavailableAcquire(request);
    if (rejected !== undefined) {
      return rejected;
    }
    return { ok: true, value: commitWarmPlacement(request, reason) };
  }

  function commitWarmPlacement(
    request: PtcExecuteCodePlacementRequest,
    reason: PtcExecuteCodePlacementDecisionReason,
  ): PtcExecuteCodeWarmSessionPlacement {
    lastWarmGeneration += 1;
    const decision: PtcExecuteCodePlacementDecision = {
      selectedLane: 'warm_session',
      reason,
    };
    const observation = createPtcExecuteCodePlacementObservation(
      request,
      decision,
    );
    const placement: PtcExecuteCodeWarmSessionPlacement = {
      kind: 'warm_session',
      lease: {
        leaseId: `ptc_warm_lease_${randomUUID()}`,
        generation: lastWarmGeneration,
        shutdownEpoch,
        ownerThreadId: request.identity.threadId,
      },
      ...placementRequestFields(request, observation),
    };
    activeWarmPlacement = placement;
    retainedWarmPlacement = placement;
    requestStandbyRefill(request.identity);
    return placement;
  }

  function commitBurstPlacement(
    request: PtcExecuteCodePlacementRequest,
  ): PtcExecuteCodeBurstSessionPlacement {
    lastBurstGeneration += 1;
    const standbyIdentity = args.standbyPool?.claimReady(request.identity);
    const identity =
      standbyIdentity ?? createColdBurstIdentity(request.identity);
    const reason: PtcExecuteCodePlacementDecisionReason =
      request.ownerKind === 'child'
        ? 'child_cold_burst'
        : 'cold_burst_spillover';
    const observation = createPtcExecuteCodePlacementObservation(request, {
      selectedLane: 'cold_burst',
      reason,
    });
    const common = placementRequestFields(request, observation, identity);
    const placement: PtcExecuteCodeBurstSessionPlacement = {
      ...common,
      kind: 'burst',
      provisioning:
        standbyIdentity === undefined ? 'coldCreate' : 'standbyRestore',
      identity,
      lease: {
        leaseId: `ptc_burst_lease_${randomUUID()}`,
        generation: lastBurstGeneration,
        shutdownEpoch,
        ownerThreadId: request.identity.threadId,
      },
    };
    activeBurstPlacements.set(placement.lease.leaseId, { placement });
    requestStandbyRefill(request.identity);
    return placement;
  }

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
    settlePendingAcquire(pending, cancelledAcquireFailure(pending.request));
  }

  function drainWarmQueue(): void {
    if (
      shutdownState !== 'open' ||
      activeWarmPlacement !== undefined ||
      warmTransition !== undefined
    ) {
      return;
    }
    const pending = pendingWarmQueue.shift();
    if (pending === undefined) {
      return;
    }
    void Promise.resolve(acquireWarmPlacement(pending.request)).then(
      (result) => {
        settlePendingAcquire(pending, result);
      },
    );
  }

  function drainBurstQueue(): void {
    if (shutdownState !== 'open' || burstConfig?.enabled !== true) {
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
      const resourceAdmission = readBurstResourceAdmission(
        pending.request.identity,
      );
      if (resourceAdmission?.ok === false) {
        return;
      }
      const shifted = shiftPendingAcquire(pendingBurstByThread, selected);
      if (shifted === undefined) {
        continue;
      }
      settlePendingAcquire(shifted, {
        ok: true,
        value: commitBurstPlacement(
          withResourceSnapshotRef(shifted.request, resourceAdmission?.budget),
        ),
      });
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

  async function releasePlacement(
    placement: PtcExecuteCodeExecutionPlacement,
  ): Promise<PtcExecuteCodePlacementReleaseResult> {
    if (placement.kind === 'warm_session') {
      const active = activeWarmPlacement;
      if (
        active?.lease.leaseId !== placement.lease.leaseId ||
        active.lease.generation !== placement.lease.generation
      ) {
        return { ok: true };
      }
      activeWarmPlacement = undefined;
      drainWarmQueue();
      return { ok: true };
    }

    const active = activeBurstPlacements.get(placement.lease.leaseId);
    if (
      active === undefined ||
      active.placement.lease.generation !== placement.lease.generation
    ) {
      return { ok: true };
    }
    if (active.cleanup !== undefined) {
      return await active.cleanup;
    }
    const cleanup = closeBurstPlacement(active);
    active.cleanup = cleanup;
    const result = await cleanup;
    if (!result.ok) {
      delete active.cleanup;
    }
    return result;
  }

  async function closeBurstPlacement(
    active: ActiveBurstPlacement,
  ): Promise<PtcExecuteCodePlacementReleaseResult> {
    const closed = await active.placement.sessionManager.close(
      active.placement.identity,
    );
    if (!closed.ok) {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC burst cleanup failed',
        diagnostics: {
          cleanupReasonCode: closed.reasonCode,
          placementLane: 'cold_burst',
        },
      };
    }
    activeBurstPlacements.delete(active.placement.lease.leaseId);
    requestStandbyRefill(active.placement.identity);
    drainBurstQueue();
    return { ok: true };
  }

  async function reapPlacements(): Promise<PtcExecuteCodePlacementReleaseResult> {
    let firstFailure: PtcExecuteCodePlacementReleaseResult | undefined;
    for (const active of [...activeBurstPlacements.values()]) {
      const result = await releasePlacement(active.placement);
      if (!result.ok && firstFailure === undefined) {
        firstFailure = result;
      }
    }
    const standbyCleanup = await args.standbyPool?.close();
    if (
      standbyCleanup !== undefined &&
      !standbyCleanup.ok &&
      firstFailure === undefined
    ) {
      firstFailure = {
        ok: false,
        reasonCode: 'ptc_execute_code_session_cleanup_failed',
        message: 'PTC execute_code standby cleanup failed',
        diagnostics: {
          cleanupReasonCode: standbyCleanup.reasonCode,
          placementLane: 'standby_pool',
        },
      };
    }
    return firstFailure ?? { ok: true };
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
      settlePendingAcquire(
        entry,
        shutdownAcquireFailure(entry.request, shutdownState, shutdownEpoch),
      );
    }
  }

  return {
    acquirePlacement,
    releasePlacement,
    reapPlacements,
    refreshQueuedPlacements() {
      drainBurstQueue();
    },
    beginShutdown() {
      if (shutdownState !== 'open') {
        return;
      }
      shutdownState = 'closing';
      shutdownEpoch += 1;
      rejectPendingAcquires();
    },
    finishShutdown() {
      if (shutdownState === 'open') {
        shutdownEpoch += 1;
      }
      shutdownState = 'closed';
      rejectPendingAcquires();
      activeWarmPlacement = undefined;
      retainedWarmPlacement = undefined;
      activeBurstPlacements.clear();
    },
  };

  function rejectUnavailableAcquire(
    request: PtcExecuteCodePlacementRequest,
  ): PtcExecuteCodePlacementAcquireFailure | undefined {
    if (request.signal?.aborted === true) {
      return cancelledAcquireFailure(request);
    }
    if (shutdownState !== 'open') {
      return shutdownAcquireFailure(request, shutdownState, shutdownEpoch);
    }
    return undefined;
  }

  function requestStandbyRefill(identity: PtcSessionDockerIdentity): void {
    const standbyPool = args.standbyPool;
    if (standbyPool === undefined) {
      return;
    }
    void standbyPool.refill(identity, () => {
      const admission = readStandbyResourceAdmission(identity);
      return admission?.ok !== false;
    });
  }

  function readBurstResourceAdmission(
    identity: PtcSessionDockerIdentity,
  ): PtcExecuteCodeBurstResourceAdmission | undefined {
    if (
      args.placementResourceBudgetProvider === undefined ||
      args.resourceRequirements === undefined
    ) {
      return undefined;
    }
    const inventory = args.standbyPool?.readInventory(identity) ?? {
      readySlotCount: 0,
      reservedSlotCount: 0,
    };
    return admitPtcExecuteCodeResources({
      projectedExecutionCount:
        (activeWarmPlacement === undefined ? 0 : 1) +
        activeBurstPlacements.size +
        1,
      projectedContainerCount:
        (retainedWarmPlacement === undefined ? 0 : 1) +
        activeBurstPlacements.size +
        inventory.reservedSlotCount +
        (inventory.readySlotCount > 0 ? 0 : 1),
      budget: args.placementResourceBudgetProvider(),
      requirements: args.resourceRequirements,
    });
  }

  function readStandbyResourceAdmission(
    identity: PtcSessionDockerIdentity,
  ): PtcExecuteCodeBurstResourceAdmission | undefined {
    if (
      args.placementResourceBudgetProvider === undefined ||
      args.resourceRequirements === undefined ||
      args.standbyPool === undefined
    ) {
      return undefined;
    }
    const inventory = args.standbyPool.readInventory(identity);
    return admitPtcExecuteCodeResources({
      projectedExecutionCount:
        (activeWarmPlacement === undefined ? 0 : 1) +
        activeBurstPlacements.size,
      projectedContainerCount:
        (retainedWarmPlacement === undefined ? 0 : 1) +
        activeBurstPlacements.size +
        inventory.reservedSlotCount +
        1,
      budget: args.placementResourceBudgetProvider(),
      requirements: args.resourceRequirements,
    });
  }
}

function isSameRetainedWarmIdentity(
  placement: PtcExecuteCodeWarmSessionPlacement,
  request: PtcExecuteCodePlacementRequest,
): boolean {
  return (
    placement.sessionManager === request.sessionManager &&
    placement.identity.threadId === request.identity.threadId &&
    buildPtcExecuteCodeStandbyIdentityKey(placement.identity) ===
      buildPtcExecuteCodeStandbyIdentityKey(request.identity)
  );
}

function warmReplacementFailure(
  request: PtcExecuteCodePlacementRequest,
  cleanupReasonCode: string,
): PtcExecuteCodePlacementAcquireFailure {
  return {
    ok: false,
    reasonCode: 'ptc_lab_session_unavailable',
    message: 'PTC retained main session could not be replaced safely',
    remediation:
      'Retry after the previous main session cleanup succeeds; a second retained main session will not be created.',
    diagnostics: {
      placementLane: 'warm_session',
      placementOwnerKind: request.ownerKind,
      cleanupReasonCode,
    },
  };
}

function admitPtcExecuteCodeResources(args: {
  projectedExecutionCount: number;
  projectedContainerCount: number;
  budget: PtcExecuteCodePlacementResourceBudget;
  requirements: PtcSessionDockerResourceRequirements;
}): PtcExecuteCodeBurstResourceAdmission {
  const measurements = [
    args.budget.availableParallelism,
    args.budget.constrainedMemoryBytes,
    args.budget.availableMemoryBytes,
  ];
  if (measurements.some((measurement) => !measurement.ok)) {
    return {
      ok: false,
      budget: args.budget,
      reason: 'resource_budget_unavailable',
    };
  }

  const requiredCpuUnits =
    args.projectedExecutionCount * args.requirements.cpuUnits;
  const requiredMemoryBytes =
    args.projectedContainerCount * args.requirements.memoryBytes;
  const availableParallelism = args.budget.availableParallelism;
  const constrainedMemoryBytes = args.budget.constrainedMemoryBytes;
  const availableMemoryBytes = args.budget.availableMemoryBytes;
  if (
    !availableParallelism.ok ||
    !constrainedMemoryBytes.ok ||
    !availableMemoryBytes.ok ||
    !Number.isSafeInteger(requiredMemoryBytes) ||
    availableParallelism.value < requiredCpuUnits ||
    constrainedMemoryBytes.value < requiredMemoryBytes ||
    availableMemoryBytes.value < args.requirements.memoryBytes
  ) {
    return {
      ok: false,
      budget: args.budget,
      reason: 'resource_budget_insufficient',
    };
  }
  return { ok: true, budget: args.budget };
}

function withResourceSnapshotRef(
  request: PtcExecuteCodePlacementRequest,
  budget: PtcExecuteCodePlacementResourceBudget | undefined,
): PtcExecuteCodePlacementRequest {
  if (budget === undefined) {
    return request;
  }
  return { ...request, resourceSnapshotRef: budget.resourceSnapshotRef };
}

function validateResourceRequirements(
  requirements: PtcSessionDockerResourceRequirements,
): void {
  if (!Number.isFinite(requirements.cpuUnits) || requirements.cpuUnits <= 0) {
    throw new Error('PTC execute_code burst CPU requirement is invalid');
  }
  if (
    !Number.isSafeInteger(requirements.memoryBytes) ||
    requirements.memoryBytes < 1
  ) {
    throw new Error('PTC execute_code burst memory requirement is invalid');
  }
}

function createColdBurstIdentity(
  identity: PtcSessionDockerIdentity,
): PtcExecuteCodeStandbyIdentity {
  return {
    ...identity,
    ephemeralBurstId: `ptc_burst_${randomUUID()}`,
  };
}

function placementRequestFields(
  request: PtcExecuteCodePlacementRequest,
  observation: PtcExecuteCodePlacementObservation,
  identity: PtcSessionDockerIdentity = request.identity,
): PtcExecuteCodePlacementBase {
  return {
    executionKind: request.kind,
    continuity: request.continuity,
    observation,
    preflight: createPtcExecuteCodePlacementPreflightRecord(observation),
    ...(request.kind === 'detached_cell' ? { cellId: request.cellId } : {}),
    identity,
    sessionManager: request.sessionManager,
    batchRunner: request.batchRunner,
  };
}

function readWarmDecisionReason(
  request: PtcExecuteCodePlacementRequest,
  burstEnabled: boolean,
): PtcExecuteCodePlacementDecisionReason {
  if (
    !isPtcExecuteCodePlacementBurstEligible(
      request.continuity,
      request.callbackEffectPolicy,
    ) &&
    request.continuity.kind === 'independent'
  ) {
    return 'callback_effect_requires_warm';
  }
  switch (request.continuity.kind) {
    case 'requires_warm_continuity':
      return 'warm_continuity_required';
    case 'defer_to_warm':
      return 'independence_not_proven';
    case 'independent':
      return burstEnabled ? 'warm_available' : 'burst_not_enabled_yet';
  }
}

function busyPlacementFailure(
  request: PtcExecuteCodePlacementRequest,
  burstEligible: boolean,
  burstConfig: PtcExecuteCodeBurstPlacementConfig | undefined,
  active: PtcExecuteCodeWarmSessionPlacement | undefined,
): PtcExecuteCodePlacementAcquireFailure {
  return {
    ok: false,
    reasonCode: 'ptc_lab_session_busy',
    message: 'PTC warm session already has an active placement lease',
    remediation:
      burstConfig?.enabled === true
        ? 'Use the detached-cell exec lane so capacity pressure can return a queued cell and resume fairly.'
        : 'Wait for the active exec cell to settle before retrying; cold burst placement is not enabled.',
    diagnostics: {
      placementLane: 'warm_session',
      placementOwnerKind: request.ownerKind,
      burstEligible,
      coldBurstAvailable: burstConfig?.enabled === true,
      ...(active === undefined
        ? {}
        : {
            activeExecutionKind: active.executionKind,
            activeLeaseGeneration: active.lease.generation,
            ...(active.cellId === undefined
              ? {}
              : { activeCellId: active.cellId }),
          }),
    },
  };
}

function cancelledAcquireFailure(
  request: PtcExecuteCodePlacementRequest,
): PtcExecuteCodePlacementAcquireFailure {
  return {
    ok: false,
    reasonCode: 'ptc_lab_command_cancelled',
    message: 'PTC placement acquisition was cancelled',
    diagnostics: {
      abortedBeforeAcquire: true,
      ownerThreadId: request.identity.threadId,
    },
  };
}

function shutdownAcquireFailure(
  request: PtcExecuteCodePlacementRequest,
  shutdownState: 'open' | 'closing' | 'closed',
  shutdownEpoch: number,
): PtcExecuteCodePlacementAcquireFailure {
  return {
    ok: false,
    reasonCode: 'ptc_lab_session_unavailable',
    message: 'PTC placement owner is shutting down',
    diagnostics: {
      placementShutdownState: shutdownState,
      shutdownEpoch,
      ownerThreadId: request.identity.threadId,
    },
  };
}

function shiftPendingAcquire(
  queueMap: Map<string, PendingPlacementAcquire[]>,
  threadId: string,
): PendingPlacementAcquire | undefined {
  const queue = queueMap.get(threadId);
  const pending = queue?.shift();
  if (queue !== undefined && queue.length === 0) {
    queueMap.delete(threadId);
  }
  return pending;
}
