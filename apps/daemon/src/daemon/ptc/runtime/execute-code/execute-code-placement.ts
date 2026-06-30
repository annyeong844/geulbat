import type { createPtcLabSessionBatchCommandRunner } from '../../lab/shell/lab-session-batch-command.js';
import type {
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodePlacementResourceSnapshotRef,
} from './execute-code-runtime-contract.js';

type MaybePromise<T> = T | Promise<T>;

const PTC_EXECUTE_CODE_READ_ONLY_CALLBACK_EFFECTS = Object.freeze([
  'read_only',
] as const);

export type PtcExecuteCodePlacementBatchRunner = ReturnType<
  typeof createPtcLabSessionBatchCommandRunner
>;

export type PtcExecuteCodePlacementContinuity =
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

interface PtcExecuteCodePlacementObservationBase {
  continuity: PtcExecuteCodePlacementContinuity;
  callbackEffectPolicy: PtcExecuteCodePlacementCallbackEffectPolicy;
  burstEligible: boolean;
  selectedLane: 'warm_session';
  reason: PtcExecuteCodePlacementWarmDecision['reason'];
  resourceSnapshotRef?: PtcExecuteCodePlacementResourceSnapshotRef;
}

export type PtcExecuteCodePlacementObservation =
  | (PtcExecuteCodePlacementObservationBase & {
      executionKind: 'batch_command';
    })
  | (PtcExecuteCodePlacementObservationBase & {
      executionKind: 'detached_cell';
      cellId: PtcExecuteCodeCellId;
    });

export interface PtcExecuteCodePlacementPreflightRecord {
  input: PtcExecuteCodePlacementObservation;
  warmDecision: PtcExecuteCodePlacementWarmDecision;
  burstEligible: boolean;
  selectedLane: 'warm_session';
  reason: PtcExecuteCodePlacementWarmDecision['reason'];
  resourceSnapshotRef?: PtcExecuteCodePlacementResourceSnapshotRef;
}

export interface PtcExecuteCodePlacementCallbackEffectPolicy {
  allowedEffects: readonly ['read_only'];
  mutationPolicy: 'none';
  callbackToolCount: number;
  source: 'ptc_callback_read_only_surface';
}

export interface PtcExecuteCodePlacementWarmDecision {
  selectedLane: 'warm_session';
  reason:
    | 'warm_continuity_required'
    | 'independence_not_proven'
    | 'burst_not_enabled_yet';
}

export interface PtcExecuteCodePlacementContinuityProvenance {
  independenceProof?: {
    reason: 'self_contained' | 'map_shard' | 'read_only_analysis';
  };
  warmHandles?: ReadonlyArray<{
    handleId: string;
    kind: 'warm_interpreter' | 'warm_fs' | 'warm_memo';
  }>;
  policyFailClosed?: boolean;
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

interface PtcExecuteCodeWarmSessionPlacement {
  kind: 'warm_session';
  executionKind: PtcExecuteCodePlacementRequest['kind'];
  continuity: PtcExecuteCodePlacementContinuity;
  observation: PtcExecuteCodePlacementObservation;
  preflight: PtcExecuteCodePlacementPreflightRecord;
  cellId?: PtcExecuteCodeCellId;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
}

export type PtcExecuteCodeExecutionPlacement =
  PtcExecuteCodeWarmSessionPlacement;

interface PtcExecuteCodePlacementRequestBase {
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

export type PtcExecuteCodePlacementRequest =
  | PtcExecuteCodeBatchPlacementRequest
  | PtcExecuteCodeCellPlacementRequest;

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
): boolean {
  return continuity.kind === 'independent';
}

export function createPtcExecuteCodeWarmSessionPlacementObservation(
  args: PtcExecuteCodePlacementRequest,
): PtcExecuteCodePlacementObservation {
  const warmDecision = classifyPtcExecuteCodeWarmPlacementDecision(
    args.continuity,
  );
  const base = {
    continuity: args.continuity,
    callbackEffectPolicy: args.callbackEffectPolicy,
    burstEligible: isPtcExecuteCodePlacementBurstEligible(args.continuity),
    selectedLane: warmDecision.selectedLane,
    reason: warmDecision.reason,
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
  return {
    ...base,
    executionKind: args.kind,
  };
}

export function readPtcExecuteCodePlacementObservation(
  placement: PtcExecuteCodeExecutionPlacement,
): PtcExecuteCodePlacementObservation {
  return placement.observation;
}

export function readPtcExecuteCodePlacementWarmDecision(
  input: PtcExecuteCodePlacementObservation,
): PtcExecuteCodePlacementWarmDecision {
  return {
    selectedLane: input.selectedLane,
    reason: input.reason,
  };
}

export function createPtcExecuteCodeWarmOnlyPlacementPreflightRecord(
  input: PtcExecuteCodePlacementObservation,
): PtcExecuteCodePlacementPreflightRecord {
  const warmDecision = readPtcExecuteCodePlacementWarmDecision(input);
  return {
    input,
    warmDecision,
    burstEligible: input.burstEligible,
    selectedLane: warmDecision.selectedLane,
    reason: warmDecision.reason,
    ...(input.resourceSnapshotRef === undefined
      ? {}
      : { resourceSnapshotRef: input.resourceSnapshotRef }),
  };
}

export function classifyPtcExecuteCodeWarmPlacementDecision(
  continuity: PtcExecuteCodePlacementContinuity,
): PtcExecuteCodePlacementWarmDecision {
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

export function createPtcExecuteCodeReadOnlyCallbackEffectPolicy(args: {
  callbackToolCount: number;
}): PtcExecuteCodePlacementCallbackEffectPolicy {
  return Object.freeze({
    allowedEffects: PTC_EXECUTE_CODE_READ_ONLY_CALLBACK_EFFECTS,
    mutationPolicy: 'none',
    callbackToolCount: args.callbackToolCount,
    source: 'ptc_callback_read_only_surface',
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
  ): MaybePromise<PtcExecuteCodeExecutionPlacement>;
  releasePlacement(
    placement: PtcExecuteCodeExecutionPlacement,
  ): MaybePromise<void>;
}

export function createPtcExecuteCodeWarmSessionPlacementCoordinator(): PtcExecuteCodePlacementCoordinator {
  return {
    acquirePlacement(args) {
      const observation =
        createPtcExecuteCodeWarmSessionPlacementObservation(args);
      return {
        kind: 'warm_session',
        executionKind: args.kind,
        continuity: args.continuity,
        observation,
        preflight:
          createPtcExecuteCodeWarmOnlyPlacementPreflightRecord(observation),
        ...(args.kind === 'detached_cell' ? { cellId: args.cellId } : {}),
        identity: args.identity,
        sessionManager: args.sessionManager,
        batchRunner: args.batchRunner,
      };
    },
    releasePlacement(placement) {
      void placement;
    },
  };
}
