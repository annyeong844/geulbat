// PTC execute_code placement 계약 — placement 결정의 어휘(타입 모델)와
// 순수 정책 함수(연속성 분류·burst 적격·관측/preflight 빌더·env 설정)를
// 소유한다. runtime-contract/session-docker-contract와 같은 *-contract 관례.
// 상태를 가진 coordinator 구현과 그 내부 헬퍼는 execute-code-placement.ts에
// 남는다 — 이 모듈은 leaf(형제 의존은 runtime-contract 타입뿐)라 소비자가
// 구현 파일 대신 어휘만 끌어올 수 있다.
import type { createPtcLabSessionBatchCommandRunner } from '../../lab/shell/lab-session-batch-command.js';
import type {
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodePlacementContinuityProvenance,
  PtcExecuteCodePlacementResourceBudget,
  PtcExecuteCodePlacementResourceSnapshotRef,
  ValidatedExecuteCodeRequest,
} from './execute-code-runtime-contract.js';

export type MaybePromise<T> = T | Promise<T>;

const PTC_EXECUTE_CODE_READ_ONLY_CALLBACK_EFFECTS = Object.freeze([
  'read_only',
] as const);

const PTC_EXECUTE_CODE_BURST_ENABLED_ENV = 'GEULBAT_PTC_BURST_ENABLED' as const;
const PTC_EXECUTE_CODE_BURST_GLOBAL_CONCURRENCY_ENV =
  'GEULBAT_PTC_BURST_GLOBAL_CONCURRENCY' as const;
const PTC_EXECUTE_CODE_BURST_PER_IDENTITY_CONCURRENCY_ENV =
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

export type PtcExecuteCodePlacementDecisionReason =
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

export type PtcExecuteCodePlacementObservation =
  | (PtcExecuteCodePlacementObservationBase & {
      executionKind: 'batch_command';
    })
  | (PtcExecuteCodePlacementObservationBase & {
      executionKind: 'detached_cell';
      cellId: PtcExecuteCodeCellId;
    });

export interface PtcExecuteCodePlacementDecision {
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

interface PtcExecuteCodePlacementCallbackEffectPolicy {
  allowedEffects: readonly ('read_only' | 'workspace_write')[];
  mutationPolicy: 'none' | 'conflict_error';
  callbackToolCount: number;
  writeCallbackToolCount: number;
  source: 'ptc_callback_surface';
}

export type PtcExecuteCodePlacementContinuityProvenanceProvider = (
  args:
    | {
        kind: 'batch_command';
        identity: PtcSessionDockerIdentity;
        request: ValidatedExecuteCodeRequest;
      }
    | {
        kind: 'detached_cell';
        cellId: PtcExecuteCodeCellId;
        identity: PtcSessionDockerIdentity;
        request: ValidatedExecuteCodeRequest;
      },
) => PtcExecuteCodePlacementContinuityProvenance | undefined;

export interface PtcExecuteCodePlacementBase {
  executionKind: PtcExecuteCodePlacementRequest['kind'];
  continuity: PtcExecuteCodePlacementContinuity;
  observation: PtcExecuteCodePlacementObservation;
  preflight: PtcExecuteCodePlacementPreflightRecord;
  cellId?: PtcExecuteCodeCellId;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
}

export interface PtcExecuteCodeWarmSessionPlacement extends PtcExecuteCodePlacementBase {
  kind: 'warm_session';
  lease: PtcExecuteCodeWarmSessionLease;
}

export interface PtcExecuteCodeBurstSessionPlacement extends PtcExecuteCodePlacementBase {
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

export type PtcExecuteCodePlacementAcquireFailure = {
  ok: false;
  reasonCode:
    | 'ptc_lab_command_cancelled'
    | 'ptc_lab_session_busy'
    | 'ptc_lab_session_unavailable';
  message: string;
  remediation?: string;
  diagnostics: Record<string, string | number | boolean>;
};

export type PtcExecuteCodeSettledPlacementAcquireResult =
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

export interface PtcExecuteCodeCellPlacementRequest extends PtcExecuteCodePlacementRequestBase {
  kind: 'detached_cell';
  cellId: PtcExecuteCodeCellId;
}

export type PtcExecuteCodePlacementRequest =
  | PtcExecuteCodeBatchPlacementRequest
  | PtcExecuteCodeCellPlacementRequest;

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

export type PtcExecuteCodeBurstResourceAdmission =
  | { ok: true; budget: PtcExecuteCodePlacementResourceBudget }
  | {
      ok: false;
      budget: PtcExecuteCodePlacementResourceBudget;
      reason: 'resource_budget_unavailable' | 'resource_budget_insufficient';
    };
